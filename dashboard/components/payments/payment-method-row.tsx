"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Chip } from "@/components/patterns/chip";
import { MoreMenu } from "@/components/patterns/more-menu";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { paymentMethodRows, viaName } from "@/components/payments/payment-method-card";
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
  gatewayName,
  note,
  primaryAction,
  menu,
}: {
  pm: PaymentMethod;
  tz: string | null;
  /** `gatewayDisplayName(pm.provider, catalog)`; a gateway with no logo needs it. */
  gatewayName?: string | null;
  /** A quiet line of context the instrument cannot carry ("Set on this subscription"). */
  note?: React.ReactNode;
  /** The one action kept visible beside the menu (Make primary). */
  primaryAction?: React.ReactNode;
  /** Extra menu items after Details. */
  menu?: React.ReactNode;
}) {
  const [details, setDetails] = React.useState(false);
  const [now] = React.useState(() => Date.now());
  const exp = expiry(pm);
  const soon =
    pm.exp_month && pm.exp_year
      ? Date.UTC(pm.exp_year, pm.exp_month, 1) - now <= 30 * 86_400_000
      : false;
  return (
    <li className="py-3">
      <Popover open={details} onOpenChange={setDetails}>
        <PopoverAnchor asChild>
          {/* Wraps: in a narrow card (a docked panel beside a wide page) the actions move to a
              second line together, instead of squeezing the name until its chips overlap them. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
              <InstrumentMark
                brand={pm.brand}
                type={pm.type}
                mandateRail={pm.mandate?.rail}
                last4={pm.last4}
              />
            </span>
            <div className="min-w-0 flex-[1_1_10rem]">
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
                via {viaName(pm, gatewayName)}
                {note ? <> · {note}</> : null}
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-3">
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
          </div>
        </PopoverAnchor>
        {/* Facts only: the row above already shows the mark, name and role. At least
            24rem wide so "Payment method ID" fits its 40% label column on one line. */}
        <PopoverContent
          aria-label={`${paymentMethodName(pm)} details`}
          className="w-(--radix-popper-anchor-width) min-w-[min(24rem,calc(100vw-2rem))] px-4 py-3"
        >
          <Facts
            rows={(paymentMethodRows(pm, tz, gatewayName).filter(Boolean) as KeyValueRow[]).map(
              (r) => ({
                label: r.label,
                value: r.copy ? (
                  <span className="inline-flex max-w-full items-start gap-1">
                    <span className="min-w-0 wrap-anywhere">{r.value}</span>
                    <CopyButton value={r.copy} />
                  </span>
                ) : (
                  r.value
                ),
              }),
            )}
          />
        </PopoverContent>
      </Popover>
    </li>
  );
}
