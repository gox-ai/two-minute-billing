"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { Field } from "@/components/form/field";
import { useFieldError } from "@/components/form/action-form";
import { MoneyField, majorToMinor, SwitchRow, Wide } from "@/components/catalog/form-kit";
import {
  METERABLE_MODELS,
  RECURRING_AGGREGATIONS,
  USAGE_AGGREGATIONS,
  aggregationLabel,
} from "@/lib/usage-aggregation";
import { money } from "@/lib/format";
import { toMajorInput, toMinor } from "@/lib/money";
import type { Price } from "@/lib/api";
import {
  MeterRateCard,
  type MeterOption,
  type MeterPricing,
} from "@/components/catalog/meter-rate-card";

/** Pricing: model, amount or tiers, package / percentage terms. */

export const MODELS = [
  "flat",
  "per_unit",
  "tiered",
  "volume",
  "stairstep",
  "package",
  "usage",
  "percentage",
  "graduated_percentage",
] as const;
export type Model = (typeof MODELS)[number];

export const MODEL_LABEL: Record<string, string> = {
  flat: "Flat fee",
  per_unit: "Per unit",
  tiered: "Tiered",
  volume: "Volume",
  stairstep: "Stairstep",
  package: "Package",
  usage: "Usage",
  percentage: "Percentage",
  graduated_percentage: "Graduated percentage",
};

const MODEL_HINT: Record<string, string> = {
  flat: "One price for any quantity",
  per_unit: "Price × quantity",
  tiered: "We bill each unit at the rate of its bracket",
  volume: "We bill all units at the rate of the bracket that holds the total",
  stairstep: "One fixed fee for the bracket that holds the quantity",
  package: "A price for each bundle of units. We round a partial bundle up",
  usage: "Rate × reported usage for the period",
  percentage: "A percentage of a reported amount",
  graduated_percentage:
    "A percentage of a reported amount. Each part of the amount gets the rate of its bracket",
};

const TIER_MODELS = new Set(["tiered", "volume", "stairstep", "graduated_percentage"]);
const AMOUNT_MODELS = new Set(["flat", "per_unit", "package", "usage"]);

export interface TierRow {
  /** Quantity threshold (major money for graduated percentage); blank on the last row = and above. */
  upTo: string;
  /** Major units. */
  unit: string;
  flat: string;
  /** Graduated percentage: percent, e.g. "2.5". */
  rate: string;
}

export interface PricingValues {
  model: string;
  /** Major units. */
  amount: string;
  tiers: TierRow[];
  package_size: string;
  /** Units for package; MAJOR money for percentage (a free base amount). */
  free_units: string;
  /** Percent, e.g. "2.5". */
  percent: string;
  usage_aggregation: string;
  /** Tier, package and percentage models: bill the subscription quantity or recorded usage. */
  bill_from: "quantity" | "usage";
  usage_recurring: boolean;
  /** weighted_sum only. */
  usage_time_unit: string;
  /** Minimum spend per period, major units; blank = none. */
  minimum: string;
}

export function pricingSeed(p?: Price | null, model = "per_unit"): PricingValues {
  const cur = p?.currency ?? "USD";
  const m = p?.model ?? model;
  return {
    model: m,
    amount: p?.amount_minor != null ? toMajorInput(p.amount_minor, cur) : "",
    tiers: p?.tiers?.length
      ? p.tiers.map((t) => ({
          upTo:
            t.upToMinor == null
              ? ""
              : m === "graduated_percentage"
                ? toMajorInput(t.upToMinor, cur)
                : String(t.upToMinor),
          unit: t.unitAmountMinor != null ? toMajorInput(t.unitAmountMinor, cur) : "",
          flat: t.flatAmountMinor != null ? toMajorInput(t.flatAmountMinor, cur) : "",
          rate: t.rateBps != null ? String(t.rateBps / 100) : "",
        }))
      : [
          { upTo: "10", unit: "", flat: "", rate: "" },
          { upTo: "", unit: "", flat: "", rate: "" },
        ],
    package_size: p?.package_size != null ? String(p.package_size) : "",
    free_units:
      p?.free_units != null
        ? m === "percentage"
          ? toMajorInput(p.free_units, cur)
          : String(p.free_units)
        : "",
    percent: p?.percentage_bps != null ? String(p.percentage_bps / 100) : "",
    usage_aggregation: p?.usage_aggregation ?? "sum",
    bill_from: p?.usage_aggregation != null && m !== "usage" ? "usage" : "quantity",
    usage_recurring: p?.usage_recurring ?? false,
    usage_time_unit: p?.usage_time_unit ?? "hour",
    minimum: p?.minimum_amount_minor != null ? toMajorInput(p.minimum_amount_minor, cur) : "",
  };
}

const filled = (t: TierRow) => t.upTo !== "" || t.unit !== "" || t.flat !== "" || t.rate !== "";

export function tiersWire(tiers: TierRow[], currency: string, model?: string): string {
  const graduatedPct = model === "graduated_percentage";
  return JSON.stringify(
    tiers.filter(filled).map((t) => {
      const unit = majorToMinor(t.unit, currency);
      const flat = majorToMinor(t.flat, currency);
      const rate = bps(t.rate);
      const upTo =
        t.upTo.trim() === "" ? null : graduatedPct ? majorToMinor(t.upTo, currency) : t.upTo;
      return {
        upToMinor: upTo == null || upTo === "" ? null : Number(upTo),
        ...(!graduatedPct && unit !== "" ? { unitAmountMinor: Number(unit) } : {}),
        ...(graduatedPct && rate !== "" ? { rateBps: Number(rate) } : {}),
        ...(flat !== "" ? { flatAmountMinor: Number(flat) } : {}),
      };
    }),
  );
}

function bps(percent: string): string {
  const n = Number(percent);
  return percent.trim() !== "" && Number.isFinite(n) ? String(Math.round(n * 100)) : "";
}

/**
 * The fields. `prefix` namespaces every posted name (the new-plan form posts its
 * price under `pp_`). `lockedModel` hides the picker on edit — the engine cannot
 * change a price's model.
 */
export function PricingFields({
  values,
  onChange,
  currency,
  prefix = "",
  lockedModel = false,
  lockedAggregation = false,
  unitLabel,
  recurring = true,
  meter,
}: {
  values: PricingValues;
  onChange: (patch: Partial<PricingValues>) => void;
  currency: string;
  prefix?: string;
  lockedModel?: boolean;
  lockedAggregation?: boolean;
  unitLabel?: string;
  /** A one-time price has no period, so it has no minimum spend. */
  recurring?: boolean;
  /** Meter prices: a recurring Usage price may bill from a meter instead of usage records. */
  meter?: {
    values: MeterPricing;
    onChange: (patch: Partial<MeterPricing>) => void;
    meters: MeterOption[];
    locked?: boolean;
  };
}) {
  const n = (k: string) => `${prefix}${k}`;
  const m = values.model;
  const meterable =
    !!meter && m === "usage" && recurring && (meter.meters.length > 0 || !!meter.values.meter);
  const fromMeter = meterable && !!meter!.values.meter;
  const amountLabel =
    m === "per_unit"
      ? "Price per unit"
      : m === "usage"
        ? "Rate per unit of usage"
        : m === "package"
          ? "Price per package"
          : "Price";
  return (
    <>
      {lockedModel ? null : (
        <Field name={n("model")} label="Pricing model" help={MODEL_HINT[m]}>
          <SelectField
            name={n("model")}
            value={m}
            onValueChange={(v) => onChange({ model: v })}
            ariaLabel="Pricing model"
            options={MODELS.map((x) => ({ value: x, label: MODEL_LABEL[x] }))}
          />
        </Field>
      )}

      {meterable ? (
        <MeterRateCard
          values={meter!.values}
          onChange={meter!.onChange}
          meters={meter!.meters}
          currency={currency}
          lockedMeter={meter!.locked}
          prefix={prefix}
        />
      ) : null}

      {AMOUNT_MODELS.has(m) && !fromMeter ? (
        <Field
          name={n("amount_minor")}
          label={amountLabel}
          required
          help={m === "per_unit" && unitLabel ? `Per ${unitLabel}` : undefined}
        >
          <MoneyField
            name={n("amount_minor")}
            currency={currency}
            value={values.amount}
            onChange={(v) => onChange({ amount: v })}
            required
          />
        </Field>
      ) : null}

      {m === "package" ? (
        <>
          <Field name={n("package_size")} label="Units per package" required>
            <Input
              name={n("package_size")}
              type="number"
              min={1}
              required
              value={values.package_size}
              onChange={(e) => onChange({ package_size: e.target.value })}
              className="tabular-nums"
            />
          </Field>
          <Field
            name={n("free_units")}
            label="Free units"
            help="Free units before we count packages"
          >
            <Input
              name={n("free_units")}
              type="number"
              min={0}
              value={values.free_units}
              onChange={(e) => onChange({ free_units: e.target.value })}
              className="tabular-nums"
            />
          </Field>
        </>
      ) : null}

      {m === "percentage" ? (
        <>
          <input type="hidden" name={n("percentage_bps")} value={bps(values.percent)} />
          <Field
            name={n("percentage_bps")}
            label="Percentage"
            required
            help="Of the amount reported each period"
          >
            <div className="flex h-9 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
              <input
                id={n("percentage_bps")}
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0.01}
                max={100}
                required
                value={values.percent}
                onChange={(e) => onChange({ percent: e.target.value })}
                className="w-full min-w-0 flex-1 self-stretch rounded-l-md bg-transparent pl-3 text-sm tabular-nums outline-none"
              />
              <span className="px-3 text-sm font-medium text-muted-foreground">%</span>
            </div>
          </Field>
          <input
            type="hidden"
            name={n("free_units")}
            value={majorToMinor(values.free_units, currency)}
          />
          <Field
            name={n("free_units")}
            label="Free amount"
            help="The part of each period's amount that we do not charge"
          >
            <MoneyField
              currency={currency}
              value={values.free_units}
              onChange={(v) => onChange({ free_units: v })}
            />
          </Field>
        </>
      ) : null}

      {METERABLE_MODELS.has(m) && recurring ? (
        lockedAggregation ? (
          <Field
            name={n("bill_from")}
            label="Bill from · Locked"
            help="Set when the price was created"
          >
            <Input
              value={values.bill_from === "usage" ? "Recorded usage" : "Subscription quantity"}
              readOnly
              className="bg-muted/50"
            />
          </Field>
        ) : (
          <Field
            name={n("bill_from")}
            label="Bill from"
            help={
              values.bill_from === "usage"
                ? "We combine the usage records of each period and apply this pricing model to the result"
                : "We apply this pricing model to the quantity on the subscription"
            }
          >
            <SelectField
              value={values.bill_from}
              onValueChange={(v) => onChange({ bill_from: v as PricingValues["bill_from"] })}
              ariaLabel="Bill from"
              options={[
                { value: "quantity", label: "Subscription quantity" },
                { value: "usage", label: "Recorded usage" },
              ]}
            />
          </Field>
        )
      ) : null}

      {!fromMeter &&
      (m === "usage" || (METERABLE_MODELS.has(m) && recurring && values.bill_from === "usage")) ? (
        <UsageMeasureFields
          n={n}
          values={values}
          onChange={onChange}
          locked={lockedAggregation}
          recurring={recurring}
        />
      ) : null}

      {TIER_MODELS.has(m) ? (
        <Wide>
          <input type="hidden" name={n("tiers")} value={tiersWire(values.tiers, currency, m)} />
          <TierEditor
            name={n("tiers")}
            tiers={values.tiers}
            onChange={(tiers) => onChange({ tiers })}
            currency={currency}
            variant={
              m === "stairstep" ? "stairstep" : m === "graduated_percentage" ? "rate" : "unit"
            }
          />
        </Wide>
      ) : null}

      {recurring ? (
        <>
          <input type="hidden" name={n("minimum_present")} value="1" />
          <input
            type="hidden"
            name={n("minimum_amount_minor")}
            value={majorToMinor(values.minimum, currency)}
          />
          <Field
            name={n("minimum_amount_minor")}
            label="Minimum spend"
            help="If the charge for a period is less, we add the difference. Leave empty for no minimum"
          >
            <MoneyField
              currency={currency}
              value={values.minimum}
              onChange={(v) => onChange({ minimum: v })}
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

/** How recorded usage is combined: aggregation, carried level and time unit. Fixed after create. */
function UsageMeasureFields({
  n,
  values,
  onChange,
  locked,
  recurring,
}: {
  n: (k: string) => string;
  values: PricingValues;
  onChange: (patch: Partial<PricingValues>) => void;
  locked: boolean;
  recurring: boolean;
}) {
  const agg = values.usage_aggregation;
  const canCarry = recurring && RECURRING_AGGREGATIONS.has(agg);
  const carryHint =
    agg === "last"
      ? "For a level such as storage. The level stays until a new usage record changes it. We bill the level at the end of each period"
      : agg === "weighted_sum"
        ? "The level stays until a new usage record changes it, so a period with no records still bills"
        : "For seats or storage. The level stays until a new usage record changes it. We bill the highest level in each period";
  if (locked)
    return (
      <>
        <Field
          name={n("usage_aggregation")}
          label="Usage aggregation · Locked"
          help="Set when the price was created"
        >
          <Input value={aggregationLabel(agg)} readOnly className="bg-muted/50" />
        </Field>
        {canCarry ? (
          <SwitchRow
            label="Carry the level to the next period · Locked"
            hint="Set when the price was created"
            checked={values.usage_recurring}
            onCheckedChange={() => {}}
            disabled
          />
        ) : null}
        {agg === "weighted_sum" ? (
          <Field name={n("usage_time_unit")} label="Time unit · Locked">
            <Input
              value={values.usage_time_unit === "day" ? "Day" : "Hour"}
              readOnly
              className="bg-muted/50"
            />
          </Field>
        ) : null}
      </>
    );
  return (
    <>
      <Field
        name={n("usage_aggregation")}
        label="Usage aggregation"
        help={
          agg === "weighted_sum"
            ? "Each usage record changes the level. We bill the level multiplied by the time it was held"
            : agg === "unique"
              ? "We count the different unique keys. A remove record takes a key off"
              : "How we combine the usage records of a period"
        }
      >
        <SelectField
          name={n("usage_aggregation")}
          value={agg}
          onValueChange={(v) =>
            onChange({
              usage_aggregation: v,
              ...(RECURRING_AGGREGATIONS.has(v) ? {} : { usage_recurring: false }),
            })
          }
          ariaLabel="Usage aggregation"
          options={USAGE_AGGREGATIONS.map((a) => ({ value: a, label: aggregationLabel(a) }))}
        />
      </Field>
      {canCarry ? (
        <SwitchRow
          name={n("usage_recurring")}
          label="Carry the level to the next period"
          hint={carryHint}
          checked={values.usage_recurring}
          onCheckedChange={(v) => onChange({ usage_recurring: v })}
        />
      ) : null}
      {agg === "weighted_sum" ? (
        <Field
          name={n("usage_time_unit")}
          label="Time unit"
          help="We bill unit-hours or unit-days, rounded to the nearest whole unit for each period"
        >
          <SelectField
            name={n("usage_time_unit")}
            value={values.usage_time_unit}
            onValueChange={(v) => onChange({ usage_time_unit: v })}
            ariaLabel="Time unit"
            options={[
              { value: "hour", label: "Hour" },
              { value: "day", label: "Day" },
            ]}
          />
        </Field>
      ) : null}
    </>
  );
}

function TierEditor({
  name,
  tiers,
  onChange,
  currency,
  variant,
}: {
  name: string;
  tiers: TierRow[];
  onChange: (t: TierRow[]) => void;
  currency: string;
  /** unit = price per unit; stairstep = one price per band; rate = a percentage per band. */
  variant: "unit" | "stairstep" | "rate";
}) {
  const stairstep = variant === "stairstep";
  const rate = variant === "rate";
  const error = useFieldError(name);
  const upd = (i: number, patch: Partial<TierRow>) =>
    onChange(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="flex flex-col gap-2">
      <span id={name} className="text-sm font-medium">
        Tiers <span className="text-destructive">*</span>
      </span>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2 text-xs text-muted-foreground">
        <span>{rate ? "Up to (amount)" : "Up to (units)"}</span>
        <span>{stairstep ? "—" : rate ? "Rate (%)" : "Price per unit"}</span>
        <span>{stairstep ? "Price for the band" : "Flat fee"}</span>
        <span />
      </div>
      {tiers.map((t, i) => (
        <div
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2"
        >
          {rate ? (
            <MoneyField
              id={`${name}-upto-${i}`}
              currency={currency}
              value={t.upTo}
              onChange={(v) => upd(i, { upTo: v })}
            />
          ) : (
            <Input
              aria-label={`Tier ${i + 1} up to`}
              type="number"
              min={1}
              value={t.upTo}
              placeholder={i === tiers.length - 1 ? "And above" : "Units"}
              onChange={(e) => upd(i, { upTo: e.target.value })}
              className="tabular-nums"
            />
          )}
          {stairstep ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : rate ? (
            <Input
              aria-label={`Tier ${i + 1} rate in percent`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              max={100}
              value={t.rate}
              onChange={(e) => upd(i, { rate: e.target.value })}
              className="tabular-nums"
            />
          ) : (
            <MoneyField
              id={`${name}-unit-${i}`}
              currency={currency}
              value={t.unit}
              onChange={(v) => upd(i, { unit: v })}
            />
          )}
          <MoneyField
            id={`${name}-flat-${i}`}
            currency={currency}
            value={t.flat}
            onChange={(v) => upd(i, { flat: v })}
          />
          {tiers.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove tier ${i + 1}`}
              onClick={() => onChange(tiers.filter((_, j) => j !== i))}
            >
              <X className="size-4" />
            </Button>
          ) : (
            <span />
          )}
        </div>
      ))}
      <div>
        <button
          type="button"
          className="text-sm font-medium text-primary hover:underline"
          onClick={() => onChange([...tiers, { upTo: "", unit: "", flat: "", rate: "" }])}
        >
          + Add tier
        </button>
      </div>
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          For no upper limit, leave “up to” empty in the last row.
        </p>
      )}
    </div>
  );
}

// ── Preview ────────────────────────────────────────────────────────────────────

function toMinorNum(major: string, currency: string): number | null {
  const s = major.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? toMinor(n, currency) : null;
}

/** The charge at `qty` in minor units, mirroring the engine's rating; null if incomplete. */
export function chargeAt(v: PricingValues, currency: string, qty: number): number | null {
  const amt = toMinorNum(v.amount, currency);
  const tiers = v.tiers.filter(filled).map((t) => ({
    upTo:
      t.upTo.trim() === ""
        ? null
        : v.model === "graduated_percentage"
          ? toMinorNum(t.upTo, currency)
          : Number(t.upTo),
    unit: toMinorNum(t.unit, currency) ?? 0,
    flat: toMinorNum(t.flat, currency) ?? 0,
    bps: Number(bps(t.rate)) || 0,
  }));
  switch (v.model) {
    case "flat":
      return amt;
    case "per_unit":
    case "usage":
      return amt == null ? null : amt * qty;
    case "package": {
      const size = Number(v.package_size);
      if (amt == null || !size) return null;
      const billable = qty - (Number(v.free_units) || 0);
      return billable <= 0 ? 0 : Math.ceil(billable / size) * amt;
    }
    case "volume":
    case "stairstep": {
      if (!tiers.length) return null;
      const t = tiers.find((x) => x.upTo == null || qty <= x.upTo);
      if (!t) return null;
      return v.model === "stairstep" ? t.flat : t.unit * qty + t.flat;
    }
    case "tiered": {
      if (!tiers.length) return null;
      let left = qty;
      let prev = 0;
      let total = 0;
      for (const t of tiers) {
        if (left <= 0) break;
        const cap = t.upTo ?? Infinity;
        const units = Math.min(left, cap - prev);
        if (units > 0) {
          total += t.unit * units + t.flat;
          left -= units;
        }
        prev = t.upTo ?? prev;
      }
      return total;
    }
    case "graduated_percentage": {
      // `qty` is the money base in minor units. Rounded half-up once, as the engine does.
      if (!tiers.length || qty <= 0) return tiers.length ? 0 : null;
      let lower = 0;
      let total = 0;
      for (const t of tiers) {
        if (qty <= lower) break;
        total += (Math.min(qty, t.upTo ?? Infinity) - lower) * t.bps + t.flat * 10000;
        if (t.upTo == null) break;
        lower = t.upTo;
      }
      return Math.floor((total + 5000) / 10000);
    }
    default:
      return null;
  }
}

/** Short "what it costs" phrase for a summary sentence; null when the inputs are incomplete. */
export function priceSentence(
  v: PricingValues,
  currency: string,
  unit: string | undefined,
  period: string | null,
): string | null {
  const u = unit?.trim() || "unit";
  const per = period ? ` ${period}` : "";
  const amt = toMinorNum(v.amount, currency);
  switch (v.model) {
    case "flat":
      return amt == null ? null : `${money(amt, currency)}${per}`;
    case "per_unit":
      return amt == null ? null : `${money(amt, currency)} per ${u}${per}`;
    case "usage":
      return amt == null ? null : `${money(amt, currency)} per ${u} of usage${per}`;
    case "package":
      return amt == null || !v.package_size
        ? null
        : `${money(amt, currency)} per ${v.package_size} ${u}s${per}`;
    case "percentage":
      return v.percent ? `${v.percent}% of the reported amount${per}` : null;
    case "graduated_percentage": {
      const rates = v.tiers.filter(filled).map((t) => t.rate.trim());
      if (!rates.length || rates.some((r) => r === "")) return null;
      return `${rates.map((r) => `${r}%`).join(", then ")} of the reported amount, by bracket${per}`;
    }
    default: {
      const small = chargeAt(v, currency, 5);
      const big = chargeAt(v, currency, 60);
      if (small == null || big == null) return null;
      return `${money(small, currency)}${per} for 5 ${u}s, and ${money(big, currency)} for 60`;
    }
  }
}
