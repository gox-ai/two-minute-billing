"use client";

import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { modelPriceAction } from "@/app/(dashboard)/settings/model-prices/actions";
import type { InvoiceLine } from "@/lib/api";
import type { ModelPrice } from "@/lib/api/model-prices";
import {
  PRICE_SOURCE_LABEL,
  RATE_FROM_LABEL,
  formatListPrice,
  percentLabel,
} from "@/lib/model-prices";
import { fmtDate, fmtDateTime, money } from "@/lib/format";

const COST_BASIS: Record<string, string> = {
  event: "Cost on the events",
  price_list: "Your cost or the list price",
  mixed: "Event cost and the price list",
  partial: "Part of the usage has no cost",
  none: "No cost",
  no_rate: "No exchange rate for the cost currency",
};

/**
 * "Price source" on a usage line (design G1b § 5.3): the dated price rows the line used.
 * Each list row is read from `GET /v1/organization/model_prices/:id` when the popover opens.
 * Your cost shows only to people with `usage_margin:view`.
 */
export function PriceSourcePopover({
  line,
  currency,
  tz,
  showCost,
}: {
  line: InvoiceLine;
  currency: string;
  tz?: string | null;
  showCost: boolean;
}) {
  const r = line.rating;
  const segments = React.useMemo(() => r?.segments ?? [], [r]);
  const [open, setOpen] = React.useState(false);
  const [rows, setRows] = React.useState<Record<string, ModelPrice | null | "error">>({});

  React.useEffect(() => {
    if (!open) return;
    const ids = Array.from(
      new Set(segments.map((s) => s.model_price_id).filter((x): x is string => !!x)),
    ).filter((id) => !(id in rows));
    if (!ids.length) return;
    let live = true;
    Promise.all(ids.map((id) => modelPriceAction(id).then((res) => [id, res] as const))).then(
      (pairs) => {
        if (!live) return;
        setRows((prev) => {
          const next = { ...prev };
          for (const [id, res] of pairs) next[id] = res.ok ? res.data : "error";
          return next;
        });
      },
    );
    return () => {
      live = false;
    };
  }, [open, segments, rows]);

  if (!r || !segments.length) return null;
  const sources = Array.from(new Set(segments.map((s) => s.price_source).filter(Boolean)));
  // `group` holds the values of the meter's `group_by`, in the same order.
  const keys = r.group_by ?? [];
  const values = (r.group ?? []).flatMap((v, i) =>
    v === "" ? [] : [keys[i] ? `${keys[i]}: ${v}` : v],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="w-fit text-xs font-medium text-primary hover:underline">
          Price source
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] text-sm">
        <div className="flex flex-col gap-3">
          <div>
            <div className="font-medium">Price source</div>
            <div className="text-xs text-muted-foreground">
              {sources.map((x) => PRICE_SOURCE_LABEL[x!] ?? x).join(", ") || "Rate card"}
              {values.length ? ` · ${values.join(", ")}` : ""}
            </div>
          </div>
          {sources.includes("default_rate") ? (
            <p className="text-xs text-muted-foreground">
              Part or all of this usage has no list price and no cost in the line currency, so it
              bills the default rate of the rate card.
            </p>
          ) : null}
          {sources.includes("reported_cost") ? (
            <p className="text-xs text-muted-foreground">
              This usage bills the cost that each event reported, plus the markup.
            </p>
          ) : null}
          {segments.map((s, i) => {
            const row = s.model_price_id ? rows[s.model_price_id] : undefined;
            // A reported cost is money, not a rate: it has no unit price and no list base.
            const reported = s.price_source === "reported_cost";
            return (
              <div key={i} className="flex flex-col gap-1 border-t pt-2">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    {fmtDateTime(s.from, tz)} to {fmtDateTime(s.to, tz)}
                  </span>
                </div>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {reported ? null : (
                    <>
                      <dt className="text-muted-foreground">Unit price</dt>
                      <dd className="tabular-nums">
                        {formatListPrice(s.unit_amount_decimal, currency, s.quantity_divisor ?? 1)}
                      </dd>
                    </>
                  )}
                  {s.price_source ? (
                    <>
                      <dt className="text-muted-foreground">Price from</dt>
                      <dd>{PRICE_SOURCE_LABEL[s.price_source] ?? s.price_source}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Rate from</dt>
                  <dd>{RATE_FROM_LABEL[s.rate_from] ?? s.rate_from}</dd>
                  {s.markup_percent != null ? (
                    <>
                      <dt className="text-muted-foreground">Markup</dt>
                      <dd>
                        {percentLabel(s.markup_percent)} on{" "}
                        {reported
                          ? "the reported cost"
                          : s.markup_base === "cost"
                            ? "your cost"
                            : "the list price"}
                        {!reported && s.base_unit_amount_decimal
                          ? ` of ${formatListPrice(s.base_unit_amount_decimal, currency, s.quantity_divisor ?? 1)}`
                          : ""}
                      </dd>
                    </>
                  ) : null}
                  {s.model_price_id ? (
                    <>
                      <dt className="text-muted-foreground">List row</dt>
                      <dd className="font-mono">{s.model_price_id}</dd>
                      <dt className="text-muted-foreground">List price</dt>
                      <dd className="tabular-nums">
                        {row === undefined
                          ? "…"
                          : row === "error" || row === null
                            ? "We could not load the row."
                            : formatListPrice(
                                row.unit_amount_decimal,
                                row.currency,
                                row.quantity_divisor,
                              )}
                      </dd>
                      <dt className="text-muted-foreground">Source</dt>
                      <dd>
                        {s.source ?? "—"}
                        {s.source_version ? (
                          <span className="font-mono"> {s.source_version}</span>
                        ) : null}
                      </dd>
                      <dt className="text-muted-foreground">Source date</dt>
                      <dd>
                        {s.source_effective_from ? fmtDate(s.source_effective_from, "UTC") : "—"}
                      </dd>
                      <dt className="text-muted-foreground">Applies from</dt>
                      <dd>
                        {row && row !== "error"
                          ? row.effective_from
                            ? fmtDateTime(row.effective_from, tz)
                            : "Before we tracked it"
                          : "…"}
                      </dd>
                    </>
                  ) : null}
                  {showCost && s.model_cost_override_id ? (
                    <>
                      <dt className="text-muted-foreground">Your cost row</dt>
                      <dd className="font-mono">{s.model_cost_override_id}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            );
          })}
          {showCost && line.cost_basis ? (
            <div className="flex justify-between gap-3 border-t pt-2 text-xs">
              <span className="text-muted-foreground">
                Cost · {COST_BASIS[line.cost_basis] ?? line.cost_basis}
              </span>
              <span className="tabular-nums">
                {line.cost_minor != null ? money(line.cost_minor, currency) : "—"}
              </span>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
