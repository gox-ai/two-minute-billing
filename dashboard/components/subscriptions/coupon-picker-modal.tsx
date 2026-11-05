"use client";

import * as React from "react";
import { Plus, Search } from "lucide-react";

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

export function CouponPickerModal({
  coupons,
  currency,
  onSelect,
  label = "Add Coupon",
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
        {/* `size="sm"` (28rem), not a bare `max-w-md`: that class was silently outranked by
            the base `sm:max-w-lg`, so this dialog has been rendering 512px while asking for
            448px. Measured — so this DOES narrow it, by design. */}
        <DialogContent size="sm" className="z-50 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 pt-6 pb-4">
            <DialogTitle className="text-xl font-bold">{label}</DialogTitle>
            <DialogDescription>
              Select a coupon from the catalog. One coupon applies per subscription.
            </DialogDescription>
          </DialogHeader>
          <div className="border-b p-4">
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search coupons..."
                className="pl-9"
                aria-label="Search coupons"
              />
            </div>
          </div>
          <div className="max-h-72 divide-y overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {selectable.length === 0
                  ? `No active coupons available${currency ? ` in ${currency}` : ""}.`
                  : "No coupons match the search"}
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
                  className="flex w-full flex-col items-start gap-0.5 p-3.5 text-left transition-colors hover:bg-muted/50"
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
