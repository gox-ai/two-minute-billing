"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { Field } from "@/components/form/field";
import { useFieldError } from "@/components/form/action-form";
import { LockedField, Wide } from "@/components/catalog/form-kit";
import {
  DIVISORS,
  divisorChoice,
  divisorLabel,
  majorRateToMinor,
  meterAggregationLabel,
  minorRateToMajor,
} from "@/lib/meters";
import type { Price } from "@/lib/api";
import type { MeterPriceList } from "@/lib/api/meters";
import { PriceNow, rowListKey } from "@/components/model-prices/price-now";
import { isListSource } from "@/lib/model-prices";
import { cn } from "@/lib/utils";

/** What the price form needs to know about a meter. */
export interface MeterOption {
  id: string;
  name: string;
  aggregation: string;
  group_by: string[];
  /** Mapping to the model price list; required for the two list sources. */
  price_list?: MeterPriceList | null;
}

export interface RateRow {
  /** Group values by property; blank = any value. */
  values: Record<string, string>;
  /** List sources only: a fixed rate, or a markup over the price's base. */
  mode?: "rate" | "markup";
  /** Major units per divisor. */
  rate: string;
  /** Percent, when `mode` is markup. */
  markup?: string;
}

export type AmountSource =
  | "rate"
  | "event_amount"
  | "event_cost"
  | "model_price_list"
  | "event_cost_or_list";

export interface MeterPricing {
  /** Meter key; "" = the price does not bill from a meter. */
  meter: string;
  amount_source: AmountSource;
  /** The default rate, major units per divisor. */
  rate: string;
  divisor: string;
  divisor_custom: string;
  /** Percent, event_cost and the list sources. */
  markup: string;
  /** List sources: the markup applies to the list price or to your cost. */
  markup_base: "list" | "cost";
  rates: RateRow[];
}

const AMOUNT_SOURCE_LABEL: Record<AmountSource, string> = {
  rate: "Rate from the rate card",
  event_amount: "Amount on each event",
  event_cost: "Cost on each event, plus a markup",
  model_price_list: "Bill from the model price list",
  event_cost_or_list: "Reported cost, else the model price list",
};

const AMOUNT_SOURCE_HELP: Record<AmountSource, string> = {
  rate: "Quantity × rate, for each combination of group values.",
  event_amount:
    "We add the amount field of the events. Events in a different currency are not billed.",
  event_cost: "We add the cost field of the events, then add the markup.",
  model_price_list:
    "We price each model at the price in effect when the usage occurred, then add the markup. When a price changes in the period, the invoice shows one line for each price.",
  event_cost_or_list:
    "Events with a cost bill that cost plus the markup. Other events bill from the model price list.",
};

export function meterPricingSeed(p?: Price | null): MeterPricing {
  const cur = p?.currency ?? "USD";
  const d = p?.quantity_divisor ?? 1;
  return {
    meter: p?.meter ?? "",
    amount_source: (p?.amount_source as AmountSource) ?? "rate",
    rate: minorRateToMajor(p?.unit_amount_decimal, cur),
    divisor: divisorChoice(d),
    divisor_custom: divisorChoice(d) === "custom" ? String(d) : "",
    markup: p?.markup_percent ?? "",
    markup_base: p?.markup_base === "cost" ? "cost" : "list",
    rates: (p?.rates ?? []).map((r) => ({
      values: { ...r.match },
      mode: r.markup_percent != null && r.markup_percent !== "" ? "markup" : "rate",
      rate: minorRateToMajor(r.unit_amount_decimal, cur),
      markup: r.markup_percent ?? "",
    })),
  };
}

const divisorOf = (v: MeterPricing) =>
  v.divisor === "custom" ? v.divisor_custom.trim() : v.divisor;

/** One line for the summary card; null while incomplete. */
export function meterPriceSentence(
  v: MeterPricing,
  currency: string,
  meterName?: string,
): string | null {
  const of = meterName ? ` of ${meterName}` : "";
  if (v.amount_source === "event_amount") return `The amount on each event${of}, as sent`;
  if (v.amount_source === "event_cost")
    return `The cost on each event${of}, plus ${v.markup.trim() || "0"}%`;
  if (v.amount_source === "event_cost_or_list")
    return `The cost on each event, else the model price list${of}, plus ${v.markup.trim() || "0"}%`;
  if (v.amount_source === "model_price_list")
    return `The model price list${of}, plus ${v.markup.trim() || "0"}% on ${v.markup_base === "cost" ? "your cost" : "the list price"}`;
  if (!v.rate.trim()) return null;
  const extra = v.rates.length
    ? `, ${v.rates.length} more rate${v.rates.length === 1 ? "" : "s"}`
    : "";
  return `${v.rate} ${currency} ${divisorLabel(divisorOf(v) || 1)}${of}${extra}`;
}

/**
 * The meter fields of a Usage price: the meter, how the amount is found, and the rate card.
 * Only the Usage model takes a meter here; the API also takes tiers per rate, which this
 * form does not edit yet.
 */
export function MeterRateCard({
  values,
  onChange,
  meters,
  currency,
  lockedMeter,
  prefix = "",
}: {
  values: MeterPricing;
  onChange: (patch: Partial<MeterPricing>) => void;
  meters: MeterOption[];
  currency: string;
  /** Edit: the meter is fixed after create. */
  lockedMeter?: boolean;
  prefix?: string;
}) {
  const n = (k: string) => `${prefix}${k}`;
  const meter = meters.find((m) => m.id === values.meter);
  const groupBy = meter?.group_by ?? [];
  const minor = majorRateToMinor(values.rate, currency);
  const rateError =
    values.rate.trim() && minor == null
      ? "Enter a number. Use up to 12 decimal places."
      : undefined;
  const listMode = isListSource(values.amount_source);
  const costFirst = values.amount_source === "event_cost_or_list";
  const ratesWire = JSON.stringify(
    values.rates.map((r) => {
      const match = Object.fromEntries(
        Object.entries(r.values)
          .map(([k, v]) => [k, v.trim()] as const)
          .filter(([k, v]) => v !== "" && groupBy.includes(k)),
      );
      return listMode && r.mode === "markup"
        ? { match, markup_percent: (r.markup ?? "").trim() }
        : { match, unit_amount_decimal: majorRateToMinor(r.rate, currency) ?? "" };
    }),
  );
  const sources: AmountSource[] = meter?.price_list
    ? ["rate", "event_amount", "event_cost", "model_price_list", "event_cost_or_list"]
    : ["rate", "event_amount", "event_cost"];

  return (
    <>
      <input type="hidden" name={n("meter_present")} value={values.meter ? "1" : ""} />
      {lockedMeter ? (
        <Wide>
          <LockedField
            label="Bill from a meter"
            value={meter ? `${meter.name} (${meter.id})` : values.meter}
            reason="Set when the price was created."
          />
        </Wide>
      ) : (
        <Wide>
          <Field
            name={n("meter")}
            label="Bill from a meter"
            help={
              values.meter
                ? `We bill the usage events that the meter counts. ${meter ? `Aggregation: ${meterAggregationLabel(meter.aggregation)}.` : ""}`
                : "Without a meter, the price bills the usage records that you send for each subscription item."
            }
          >
            <SelectField
              name={n("meter")}
              value={values.meter}
              onValueChange={(v) => onChange({ meter: v, rates: [] })}
              ariaLabel="Bill from a meter"
              options={[
                { value: "", label: "No meter" },
                ...meters.map((m) => ({ value: m.id, label: `${m.name} (${m.id})` })),
              ]}
            />
          </Field>
        </Wide>
      )}

      {values.meter ? (
        <>
          {lockedMeter ? (
            <>
              {/* The parser reads the source to know which fields to check. */}
              <input type="hidden" name={n("amount_source")} value={values.amount_source} />
              <LockedField
                label="Amount"
                value={AMOUNT_SOURCE_LABEL[values.amount_source]}
                reason="Set when the price was created."
              />
            </>
          ) : (
            <Field
              name={n("amount_source")}
              label="Amount"
              help={
                meter?.price_list
                  ? AMOUNT_SOURCE_HELP[values.amount_source]
                  : `${AMOUNT_SOURCE_HELP[values.amount_source]} To bill from the model price list, set the model property on the meter first.`
              }
            >
              <SelectField
                name={n("amount_source")}
                value={values.amount_source}
                onValueChange={(v) => onChange({ amount_source: v as AmountSource })}
                ariaLabel="Amount"
                options={sources.map((v) => ({ value: v, label: AMOUNT_SOURCE_LABEL[v] }))}
              />
            </Field>
          )}

          {listMode ? (
            <Field
              name={n("markup_base")}
              label="Markup on"
              help={
                (values.markup_base === "cost"
                  ? "Your cost plus the markup. Without your cost for a model, we use the list price."
                  : "The list price plus the markup, whatever your cost is. Without a list price, we use your cost.") +
                (costFirst ? " This applies only to events without a cost." : "")
              }
            >
              <SelectField
                name={n("markup_base")}
                value={values.markup_base}
                onValueChange={(v) => onChange({ markup_base: v === "cost" ? "cost" : "list" })}
                ariaLabel="Markup on"
                options={[
                  { value: "list", label: "List price" },
                  { value: "cost", label: "Your cost" },
                ]}
              />
            </Field>
          ) : null}

          {values.amount_source === "event_cost" || listMode ? (
            <Field
              name={n("markup_percent")}
              label="Markup"
              help={
                listMode
                  ? "Applies to each model that has no row of its own below. 0 bills the base price."
                  : "0 bills the cost as sent."
              }
            >
              <div className="flex h-9 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
                <input
                  id={n("markup_percent")}
                  name={n("markup_percent")}
                  inputMode="decimal"
                  value={values.markup}
                  onChange={(e) => onChange({ markup: e.target.value })}
                  placeholder="0"
                  className="w-full min-w-0 flex-1 self-stretch rounded-l-md bg-transparent pl-3 text-sm tabular-nums outline-none"
                />
                <span className="px-3 text-sm font-medium text-muted-foreground">%</span>
              </div>
            </Field>
          ) : null}

          {values.amount_source === "rate" || listMode ? (
            <>
              <input type="hidden" name={n("unit_amount_decimal")} value={minor ?? ""} />
              <input type="hidden" name={n("quantity_divisor")} value={divisorOf(values)} />
              <input type="hidden" name={n("rates")} value={ratesWire} />
              {lockedMeter ? (
                <LockedField
                  label="Rates are"
                  value={divisorLabel(divisorOf(values) || 1).replace(/^per/, "Per")}
                  reason="Set when the price was created."
                />
              ) : (
                <Field name={n("quantity_divisor")} label="Rates are">
                  <div className="flex gap-2">
                    <SelectField
                      value={values.divisor}
                      onValueChange={(d) => onChange({ divisor: d })}
                      ariaLabel="Rates are"
                      options={DIVISORS.map((d) => ({ value: d.value, label: d.label }))}
                    />
                    {values.divisor === "custom" ? (
                      <Input
                        aria-label="Number of units for each rate"
                        type="number"
                        min={1}
                        step={1}
                        required
                        value={values.divisor_custom}
                        onChange={(e) => onChange({ divisor_custom: e.target.value })}
                        className="w-36 tabular-nums"
                      />
                    ) : null}
                  </div>
                </Field>
              )}
              <Wide>
                <RateRows
                  name={n("rates")}
                  groupBy={groupBy}
                  currency={currency}
                  rate={values.rate}
                  rateError={rateError}
                  onRate={(rate) => onChange({ rate })}
                  rows={values.rates}
                  onRows={(rates) => onChange({ rates })}
                  divisor={divisorLabel(divisorOf(values) || 1)}
                  costFirst={costFirst}
                  list={
                    listMode
                      ? {
                          map: meter?.price_list ?? null,
                          markup: values.markup,
                          base: values.markup_base,
                          divisor: divisorOf(values) || "1",
                        }
                      : undefined
                  }
                />
              </Wide>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function RateInput({
  label,
  value,
  onChange,
  currency,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  currency: string;
  invalid?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-9 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        invalid && "border-destructive focus-within:border-destructive",
      )}
    >
      <input
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0.00"
        className="w-full min-w-0 flex-1 self-stretch rounded-l-md bg-transparent pl-3 text-sm tabular-nums outline-none placeholder:text-muted-foreground"
      />
      <span className="px-3 text-sm font-medium text-muted-foreground select-none">{currency}</span>
    </div>
  );
}

function PercentInput({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-9 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        invalid && "border-destructive focus-within:border-destructive",
      )}
    >
      <input
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        className="w-full min-w-0 flex-1 self-stretch rounded-l-md bg-transparent pl-3 text-sm tabular-nums outline-none placeholder:text-muted-foreground"
      />
      <span className="px-3 text-sm font-medium text-muted-foreground select-none">%</span>
    </div>
  );
}

function RateRows({
  name,
  groupBy,
  currency,
  rate,
  rateError,
  onRate,
  rows,
  onRows,
  divisor,
  costFirst,
  list,
}: {
  name: string;
  groupBy: string[];
  currency: string;
  rate: string;
  rateError?: string;
  onRate: (v: string) => void;
  rows: RateRow[];
  onRows: (r: RateRow[]) => void;
  divisor: string;
  /** event_cost_or_list: a fixed rate also bills the events that have a cost. */
  costFirst?: boolean;
  /** List sources: rows take a fixed rate or a markup, and show the price now. */
  list?: {
    map: MeterPriceList | null;
    markup: string;
    base: "list" | "cost";
    divisor: string;
  };
}) {
  const ratesError = useFieldError(name);
  const defaultRateError = useFieldError("unit_amount_decimal");
  const error = ratesError ?? defaultRateError;
  // Real minimums, so a narrow screen scrolls the card inside its frame rather than clipping it.
  // The model column fits a 23-character model id in the mono face at 15px (15rem).
  const modelKey = list?.map?.model_key ?? "model";
  const groupCols = groupBy
    .map((p) => (p === modelKey ? "minmax(15rem,1.6fr)" : "minmax(8rem,1fr)"))
    .join(" ");
  const cols = list
    ? `${groupCols} 9rem minmax(10rem,1.2fr) minmax(10rem,1.2fr) 2rem`
    : `${groupCols} minmax(10rem,1.4fr) 2rem`;
  const upd = (i: number, patch: Partial<RateRow>) =>
    onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <span id={name} className="text-sm font-medium">
        Rate card <span className="text-destructive">*</span>
      </span>
      <div className="overflow-x-auto">
        <div className="flex min-w-fit flex-col gap-2">
          <div
            className="grid gap-2 text-xs text-muted-foreground"
            style={{ gridTemplateColumns: cols }}
          >
            {groupBy.map((p) => (
              <span key={p} className="font-mono">
                {p}
              </span>
            ))}
            {list ? <span>Set</span> : null}
            <span>{list ? "Value" : `Rate, ${divisor}`}</span>
            {list ? <span>Price now</span> : null}
            <span />
          </div>
          <div className="grid items-center gap-2" style={{ gridTemplateColumns: cols }}>
            {groupBy.map((p) => (
              <span key={p} className="text-sm text-muted-foreground">
                Any
              </span>
            ))}
            {list ? <span className="text-sm text-muted-foreground">Default rate</span> : null}
            <RateInput
              label="Default rate"
              value={rate}
              onChange={onRate}
              currency={currency}
              invalid={!!rateError}
            />
            {list ? (
              <span className="text-xs text-muted-foreground">
                For a model with no price, {divisor}
              </span>
            ) : null}
            <span />
          </div>
          {rows.map((r, i) => {
            const markupRow = !!list && r.mode === "markup";
            const bad = markupRow
              ? (r.markup ?? "").trim() !== "" &&
                !/^\d+(?:\.\d{1,6})?$/.test((r.markup ?? "").trim())
              : r.rate.trim() !== "" && majorRateToMinor(r.rate, currency) == null;
            const fixedMinor = !markupRow ? majorRateToMinor(r.rate, currency) : null;
            return (
              <div
                key={i}
                className="grid items-center gap-2"
                style={{ gridTemplateColumns: cols }}
              >
                {groupBy.map((p) => (
                  <Input
                    key={p}
                    aria-label={`Rate ${i + 1} ${p}`}
                    value={r.values[p] ?? ""}
                    title={r.values[p] || undefined}
                    placeholder="Any"
                    className="font-mono"
                    onChange={(e) => upd(i, { values: { ...r.values, [p]: e.target.value } })}
                  />
                ))}
                {list ? (
                  <SelectField
                    value={r.mode ?? "rate"}
                    onValueChange={(v) => upd(i, { mode: v === "markup" ? "markup" : "rate" })}
                    ariaLabel={`Rate ${i + 1} type`}
                    options={[
                      { value: "rate", label: "Fixed rate" },
                      { value: "markup", label: "Markup %" },
                    ]}
                  />
                ) : null}
                {markupRow ? (
                  <PercentInput
                    label={`Rate ${i + 1} markup`}
                    value={r.markup ?? ""}
                    onChange={(v) => upd(i, { markup: v })}
                    invalid={bad}
                  />
                ) : (
                  <RateInput
                    label={`Rate ${i + 1}`}
                    value={r.rate}
                    onChange={(v) => upd(i, { rate: v })}
                    currency={currency}
                    invalid={bad}
                  />
                )}
                {list ? (
                  <span className="text-sm tabular-nums">
                    <PriceNow
                      listKey={rowListKey(list.map, r.values)}
                      fixedMinor={fixedMinor ? { minor: fixedMinor, divisor: list.divisor } : null}
                      markup={markupRow ? (r.markup ?? "") : list.markup}
                      base={list.base}
                      currency={currency}
                    />
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove rate ${i + 1}`}
                  onClick={() => onRows(rows.filter((_, j) => j !== i))}
                >
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      </div>
      {groupBy.length ? (
        <div>
          <button
            type="button"
            className="text-sm font-medium text-primary hover:underline"
            onClick={() =>
              onRows([
                ...rows,
                { values: {}, rate: "", ...(list ? { mode: "rate", markup: "" } : {}) },
              ])
            }
          >
            + Add rate
          </button>
        </div>
      ) : null}
      {rateError || error ? (
        <p className="text-xs font-medium text-destructive">{rateError ?? error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {list
            ? `A row sets a fixed rate or its own markup for the values it names. Other models take the markup above. A model with no list price and no cost bills the default rate.${costFirst ? " A fixed rate also applies to events that have a cost." : ""} Price now is a preview: the invoice uses the price in effect when the usage occurred.`
            : groupBy.length
              ? "Each combination of values takes the row that names the most values. A combination that no row names takes the default rate, so a new value still bills."
              : "This meter has no group by properties, so one rate applies to all of its usage."}
        </p>
      )}
    </div>
  );
}
