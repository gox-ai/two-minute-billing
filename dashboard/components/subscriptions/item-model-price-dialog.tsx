"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Plus, X } from "lucide-react";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PriceNow, rowListKey } from "@/components/model-prices/price-now";
import { setItemModelPriceAction } from "@/app/(dashboard)/businesses/[biz]/subscriptions/[sub]/model-price-actions";
import type { PriceRate } from "@/lib/api";
import type { MeterPriceList } from "@/lib/api/meters";
import { majorRateToMinor, minorRateToMajor } from "@/lib/meters";
import { perLabel } from "@/lib/model-prices";
import { cn } from "@/lib/utils";

/** `token_type` → "Token type": a column header names the dimension, not the key. */
const dimensionLabel = (key: string) => {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A number field with its unit spelled out inside the right edge. */
function UnitInput({
  unit,
  className,
  ...props
}: React.ComponentProps<"input"> & { unit: string }) {
  return (
    <div
      className={cn(
        "flex h-9 min-w-0 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        className,
      )}
    >
      <input
        inputMode="decimal"
        {...props}
        className="w-full min-w-0 flex-1 self-stretch rounded-l-md bg-transparent pl-3 text-sm tabular-nums outline-none placeholder:text-muted-foreground"
      />
      <span className="px-3 text-sm font-medium text-muted-foreground">{unit}</span>
    </div>
  );
}

interface Row {
  values: Record<string, string>;
  mode: "rate" | "markup";
  /** Major units per the price's divisor. */
  rate: string;
  markup: string;
}

const seedRows = (rates: PriceRate[] | null | undefined, currency: string): Row[] =>
  (rates ?? []).map((r) => ({
    values: { ...r.match },
    mode: r.markup_percent != null && r.markup_percent !== "" ? "markup" : "rate",
    rate: minorRateToMajor(r.unit_amount_decimal, currency),
    markup: r.markup_percent ?? "",
  }));

/**
 * Subscription → item → Edit price, on an item that bills from the model price list. The item's
 * own markup and per-model rows are this customer's selling price; they go into the item's price
 * snapshot, so a later catalog edit does not move them.
 */
export function ItemModelPriceDialog({
  biz,
  sub,
  item,
  itemName,
  override,
  price,
  meter,
}: {
  biz: string;
  sub: string;
  item: string;
  itemName: string;
  /** The item's current override (null fields = none). */
  override: { markup_percent: string | null; rates: PriceRate[] | null };
  /** The catalog price the item bills from. */
  price: {
    currency: string;
    markup_percent: string | null;
    markup_base: "list" | "cost";
    quantity_divisor: string;
    /** `event_cost_or_list`: events with a cost bill that cost first. */
    cost_first?: boolean;
  };
  meter: { group_by: string[]; price_list: MeterPriceList | null };
}) {
  const [open, setOpen] = React.useState(false);
  const cur = price.currency;
  const [markup, setMarkup] = useDefaultState(override.markup_percent ?? "");
  const [rows, setRows] = React.useState<Row[]>(() => seedRows(override.rates, cur));
  const groupBy = meter.group_by;
  const effectiveMarkup = markup.trim() || price.markup_percent || "0";
  const wire = JSON.stringify(
    rows.map((r) => {
      const match = Object.fromEntries(
        Object.entries(r.values)
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([k, v]) => v !== "" && groupBy.includes(k)),
      );
      return r.mode === "markup"
        ? { match, markup_percent: r.markup.trim() }
        : { match, unit_amount_decimal: majorRateToMinor(r.rate, cur) ?? "" };
    }),
  );
  const upd = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cols = `repeat(${groupBy.length}, minmax(0,1fr)) 9rem minmax(0,1fr) minmax(0,1fr) 2rem`;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setMarkup(override.markup_percent ?? "");
          setRows(seedRows(override.rates, cur));
        }
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className="text-xs font-medium text-primary hover:underline">
          Edit price
        </button>
      </DialogTrigger>
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader className="pr-12">
          <DialogTitle>Edit price for this customer</DialogTitle>
          <DialogDescription>
            {price.cost_first
              ? `${itemName} bills the cost on each event, else the model price list, plus ${price.markup_percent || "0"}%. Events without a cost take the markup on ${price.markup_base === "cost" ? "your cost" : "the list price"}.`
              : `${itemName} bills from the model price list, plus ${price.markup_percent || "0"}% on ${price.markup_base === "cost" ? "your cost" : "the list price"}.`}{" "}
            Set a different markup or rate for this customer only. A change to the catalog price
            does not change these values.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={setItemModelPriceAction}
          onSuccess={() => setOpen(false)}
          className="flex min-h-0 flex-1 flex-col gap-4"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="sub" value={sub} />
          <input type="hidden" name="item" value={item} />
          <input type="hidden" name="rates" value={wire} />
          {/* The body scrolls; the footer stays. */}
          <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
            <Field
              name="markup_percent"
              label="Markup"
              help={`Leave empty to use the markup of the price (${price.markup_percent || "0"}%).`}
            >
              <UnitInput
                id="markup_percent"
                name="markup_percent"
                unit="%"
                value={markup}
                onChange={(e) => setMarkup(e.target.value)}
                placeholder={price.markup_percent || "0"}
                className="w-30"
              />
            </Field>
            <OverrideRows
              groupBy={groupBy}
              cols={cols}
              rows={rows}
              setRows={setRows}
              upd={upd}
              currency={cur}
              divisor={price.quantity_divisor}
              markup={effectiveMarkup}
              base={price.markup_base}
              map={meter.price_list}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </DialogFooter>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function OverrideRows({
  groupBy,
  cols,
  rows,
  setRows,
  upd,
  currency,
  divisor,
  markup,
  base,
  map,
}: {
  groupBy: string[];
  cols: string;
  rows: Row[];
  setRows: (r: Row[]) => void;
  upd: (i: number, patch: Partial<Row>) => void;
  currency: string;
  divisor: string;
  markup: string;
  base: "list" | "cost";
  map: MeterPriceList | null;
}) {
  const error = useFieldError("rates");
  // Phone: each rate is a small card with its own labels. Wider: one header row over
  // aligned columns. No sideways scroll at either width.
  const gridCols = { "--rate-cols": cols } as React.CSSProperties;
  const rowGrid = "grid gap-2 sm:[grid-template-columns:var(--rate-cols)]";
  const phoneLabel = "text-xs text-muted-foreground sm:hidden";
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Rates for this customer</span>
      {rows.length ? (
        <div className="flex flex-col gap-2">
          <div
            className={cn(rowGrid, "hidden text-xs font-medium text-muted-foreground sm:grid")}
            style={gridCols}
            aria-hidden="true"
          >
            {groupBy.map((p) => (
              <span key={p}>{dimensionLabel(p)}</span>
            ))}
            <span>Price type</span>
            <span>Rate or markup</span>
            <span>Price now</span>
            <span />
          </div>
          {rows.map((r, i) => {
            const fixed = r.mode === "rate" ? majorRateToMinor(r.rate, currency) : null;
            return (
              <div
                key={i}
                className={cn(
                  rowGrid,
                  "grid-cols-2 items-end max-sm:rounded-md max-sm:border max-sm:p-3 sm:items-center",
                )}
                style={gridCols}
              >
                {groupBy.map((p) => (
                  <div key={p} className="flex min-w-0 flex-col gap-1">
                    <span className={phoneLabel}>{dimensionLabel(p)}</span>
                    <Input
                      aria-label={`Rate ${i + 1} ${dimensionLabel(p).toLowerCase()}`}
                      value={r.values[p] ?? ""}
                      onChange={(e) => upd(i, { values: { ...r.values, [p]: e.target.value } })}
                    />
                  </div>
                ))}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className={phoneLabel}>Price type</span>
                  <SelectField
                    value={r.mode}
                    onValueChange={(v) => upd(i, { mode: v === "markup" ? "markup" : "rate" })}
                    ariaLabel={`Rate ${i + 1} price type`}
                    options={[
                      { value: "rate", label: "Fixed rate" },
                      { value: "markup", label: "Markup" },
                    ]}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className={phoneLabel}>Rate or markup</span>
                  <UnitInput
                    aria-label={`Rate ${i + 1} ${r.mode === "markup" ? "markup" : "fixed rate"}`}
                    unit={r.mode === "markup" ? "%" : currency}
                    value={r.mode === "markup" ? r.markup : r.rate}
                    onChange={(e) =>
                      upd(
                        i,
                        r.mode === "markup" ? { markup: e.target.value } : { rate: e.target.value },
                      )
                    }
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1 max-sm:self-center">
                  <span className={phoneLabel}>Price now</span>
                  <span className="text-sm tabular-nums">
                    <PriceNow
                      listKey={rowListKey(map, r.values)}
                      fixedMinor={fixed ? { minor: fixed, divisor } : null}
                      markup={r.mode === "markup" ? r.markup : markup}
                      base={base}
                      currency={currency}
                    />
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove rate ${i + 1}`}
                  className="max-sm:col-span-2 max-sm:justify-self-end"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-primary"
        onClick={() => setRows([...rows, { values: {}, mode: "rate", rate: "", markup: "" }])}
      >
        <Plus className="size-4" />
        Add rate
      </Button>
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          A rate sets a fixed price or a markup for the values it names. An empty cell matches every
          value. A fixed rate is in {currency} {perLabel(divisor)}. Other models use the markup
          above. Price now is a preview: the invoice uses the price in effect when the usage
          occurred.
        </p>
      )}
    </div>
  );
}
