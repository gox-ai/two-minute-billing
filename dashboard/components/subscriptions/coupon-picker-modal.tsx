"use client";

import * as React from "react";
import { Plus, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { money } from "@/lib/format";
import type { Coupon } from "@/lib/api";

/**
 * `Add Coupon` — browse the coupon catalog and pick one — as opposed to `Add Coupon
 * Code`, which is the free-text box beside it. We only ever had the box, so an
 * operator had to already know the code by heart.
 *
 * Both controls end at the SAME backend field: `coupon_code` on create
 * (`createSubBody`) and on `ChangePayload`. Picking here just fills it in.
 *
 * What the picker can honestly show is bounded by the list serializer
 * (`serializeCoupon`, src/api/portal-routes.ts): code, name, kind, percent/amount off,
 * currency, duration_type, redemptions, status. It does NOT serialize
 * `duration_in_periods`, so a `repeating` coupon's period COUNT is unavailable —
 * see `couponDurationLabel`.
 */

/** "20% off" / "₹500.00 off" — from the fields the list endpoint actually returns. */
export function couponDiscountLabel(c: Coupon, fallbackCurrency: string): string {
  if (c.percent_off_bps != null) return `${c.percent_off_bps / 100}% off`;
  if (c.amount_off_minor != null)
    return `${money(c.amount_off_minor, c.currency ?? fallbackCurrency)} off`;
  return c.kind;
}

/**
 * How long the coupon rides. This cannot name the period COUNT, because
 * `GET /v1/businesses/:biz/coupons` does not serialize `duration_in_periods` (the
 * column exists — it is set on create — it is simply not on the wire). Stating a
 * number we do not have would be a guess about money, so the repeating case says
 * only what is known.
 */
export function couponDurationLabel(c: Coupon): string {
  switch (c.duration_type) {
    case "once":
      return "Applies to the first invoice only";
    case "forever":
      return "Applies to every invoice";
    case "repeating":
      return "Applies for a limited number of billing periods";
    default:
      return c.duration_type;
  }
}

/**
 * The inline coupon-code and manual-discount editors under the line items, on create and
 * change. One frame for both: a titled block, its fields in one labelled row, and the
 * × that closes it in the corner.
 */
export function InlineEditorPanel({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  /** The ×'s accessible name — what closing does ("Remove manual discount"). */
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3 border-t bg-muted/10 px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {children}
    </section>
  );
}

/** The manual-discount choices, in the words of the "Add manual discount" dialog. */
export const DISCOUNT_TYPE_OPTIONS = [
  { value: "percent", label: "Percent off" },
  { value: "amount", label: "Fixed amount off" },
];
export const DISCOUNT_DURATION_OPTIONS = [
  { value: "one_time", label: "Next invoice only" },
  { value: "forever", label: "Forever (until removed)" },
];

export function CouponPickerModal({
  coupons,
  currency,
  onSelect,
  label = "Add coupon",
}: {
  coupons: Coupon[];
  /** The subscription's currency — a fixed-amount coupon in another one cannot apply. */
  currency: string;
  onSelect: (code: string) => void;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  // Only coupons that could actually be redeemed on THIS subscription: active, and
  // either currency-agnostic (percentage) or priced in the subscription's currency.
  // Offering the rest would be a list of choices the engine rejects on apply.
  // `currency` is empty on the create form until a plan fixes it — filter on nothing
  // then, rather than silently hiding every fixed-amount coupon.
  const selectable = React.useMemo(
    () =>
      coupons.filter(
        (c) => c.active !== false && (!currency || !c.currency || c.currency === currency),
      ),
    [coupons, currency],
  );

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return selectable;
    return selectable.filter((c) => `${c.id} ${c.name ?? ""}`.toLowerCase().includes(q));
  }, [selectable, search]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 transition-colors hover:text-primary/80"
      >
        <Plus className="size-4" /> {label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Same frame as the catalog picker (`CatalogAddModal`): one width, one padding. */}
        <DialogContent className="gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-4 pr-12">
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              Select a coupon from the catalog. One coupon applies per subscription.
            </DialogDescription>
          </DialogHeader>
          <div className="border-b px-6 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search coupons…"
                className="pl-8"
                aria-label="Search coupons"
              />
            </div>
          </div>
          <div className="max-h-80 divide-y overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {selectable.length === 0
                  ? `No active coupons available${currency ? ` in ${currency}` : ""}.`
                  : "No coupons match the search."}
              </div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onSelect(c.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="flex w-full flex-col items-start gap-0.5 px-6 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="flex w-full items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium">{c.name || c.id}</span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {couponDiscountLabel(c, currency)}
                    </span>
                  </span>
                  <span className="flex w-full items-baseline justify-between gap-3 text-xs text-muted-foreground">
                    <span className="min-w-0 truncate font-mono">{c.id}</span>
                    <span className="shrink-0">{couponDurationLabel(c)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
