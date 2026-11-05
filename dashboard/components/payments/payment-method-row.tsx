"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Chip } from "@/components/patterns/chip";
import { MoreMenu } from "@/components/patterns/more-menu";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { paymentMethodRows } from "@/components/payments/payment-method-card";
import { CopyButton } from "@/components/patterns/copy-button";
import { Facts } from "@/components/patterns/record-page";
import type { KeyValueRow } from "@/components/patterns/key-value-grid";
import type { PaymentMethod } from "@/lib/api";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export const paymentMethodName = (pm: PaymentMethod) =>
  `${pm.brand ? pm.brand[0].toUpperCase() + pm.brand.slice(1) : (pm.type ?? "Card")}${
    pm.last4 ? ` ending ${pm.last4}` : ""
  }`;

const expiry = (pm: PaymentMethod) =>
  pm.exp_month && pm.exp_year ? `${String(pm.exp_month).padStart(2, "0")}/${pm.exp_year}` : null;

/**
 * One instrument as one line — mark, name, role, expiry — with a "Details" toggle
 * on the row and the actions in the ⋯ menu. Details FLOATS under the row at its
 * width: opened inline it grew the card, and the card beside it stretched to match. The
 * customer and subscription pages both render this, so a card reads the same on both.
 */
export function PaymentMethodRow({
  pm,
  tz,
  note,
  primaryAction,
  menu,
}: {
  pm: PaymentMethod;
  tz: string | null;
  /** A quiet line of context the instrument cannot carry ("Set on this subscription"). */
  note?: React.ReactNode;
  /** The one action kept visible beside the menu (Make primary). */
  primaryAction?: React.ReactNode;
  /** Extra menu items after Details. */
  menu?: React.ReactNode;
}) {
  const [details, setDetails] = React.useState(false);
  const exp = expiry(pm);
  const soon =
    pm.exp_month && pm.exp_year
      ? Date.UTC(pm.exp_year, pm.exp_month, 1) - Date.now() <= 30 * 86_400_000
      : false;
  return (
    <li className="py-3">
      <Popover open={details} onOpenChange={setDetails}>
        <PopoverAnchor asChild>
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
              <InstrumentMark
                brand={pm.brand}
                type={pm.type}
                mandateRail={pm.mandate?.rail}
                last4={pm.last4}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {paymentMethodName(pm)}
                {pm.role === "primary" ? <Chip tone="blue">Primary</Chip> : null}
                {pm.role === "backup" ? <Chip>Backup</Chip> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {exp ? (
                  <>
                    Expires <span className={soon ? "text-warning" : undefined}>{exp}</span>
                    {" · "}
                  </>
                ) : null}
                via {pm.provider}
                {note ? <> · {note}</> : null}
              </div>
            </div>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                Details
                <ChevronDown
                  aria-hidden
                  className={`size-4 transition-transform ${details ? "rotate-180" : ""}`}
                />
              </button>
            </PopoverTrigger>
            {primaryAction}
            {menu ? (
              <MoreMenu icon label={`More for ${paymentMethodName(pm)}`}>
                {menu}
              </MoreMenu>
            ) : null}
          </div>
        </PopoverAnchor>
        {/* Facts only: the row above already shows the mark, name and role. */}
        <PopoverContent
          aria-label={`${paymentMethodName(pm)} details`}
          className="w-(--radix-popper-anchor-width) px-4 py-3"
        >
          <Facts
            rows={(paymentMethodRows(pm, tz).filter(Boolean) as KeyValueRow[]).map((r) => ({
              label: r.label,
              value: r.copy ? (
                <span className="inline-flex max-w-full items-start gap-1">
                  <span className="min-w-0 wrap-anywhere">{r.value}</span>
                  <CopyButton value={r.copy} />
                </span>
              ) : (
                r.value
              ),
            }))}
          />
        </PopoverContent>
      </Popover>
    </li>
  );
}
