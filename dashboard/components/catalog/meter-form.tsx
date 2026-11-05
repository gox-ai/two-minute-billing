"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { useFieldError } from "@/components/form/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import type { Crumb } from "@/components/page-header";
import {
  FormCard,
  FormFrame,
  LockedField,
  SummaryCard,
  SwitchRow,
  TextField,
  Wide,
  slugError,
  suggestSlug,
  useFormModel,
} from "@/components/catalog/form-kit";
import {
  createMeterAction,
  updateMeterAction,
} from "@/app/(dashboard)/businesses/[biz]/catalog/meters/actions";
import type { Meter } from "@/lib/api/meters";
import {
  AI_TOKENS_PRESET,
  MAX_GROUP_BY,
  MAX_LIMIT_DIMENSIONS,
  METER_AGGREGATIONS,
  canRecur,
  meterAggregationHint,
  meterAggregationLabel,
  needsUniqueProperty,
  needsValueProperty,
} from "@/lib/meters";

interface FilterRow {
  property: string;
  /** Comma-separated. */
  values: string;
}

interface Values {
  name: string;
  key: string;
  /** False once the operator types an ID of their own. */
  autoKey: boolean;
  event_name: string;
  aggregation: string;
  value_property: string;
  unique_property: string;
  recurring: boolean;
  time_unit: string;
  filters: FilterRow[];
  group_by: string[];
  limit_dimensions: string[];
  /** Cost section: `list` maps the meter to the model price list. */
  cost_from: "event" | "list";
  /** "" = find the provider from the model; "property" = read it from `provider_key`; else a provider. */
  provider_mode: string;
  provider_key: string;
  model_key: string;
  /** "property" = read it from `token_type_key`; else a fixed token type. */
  token_mode: string;
  token_type_key: string;
  cost_currency: string;
}

const TOKEN_TYPES = ["input", "output", "cache_read", "cache_write"];

function seedOf(m?: Meter | null): Values {
  return {
    name: m?.name ?? "",
    key: m?.id ?? "",
    autoKey: !m,
    event_name: m?.event_name ?? "",
    aggregation: m?.aggregation ?? "sum",
    value_property: m?.value_property ?? "",
    unique_property: m?.unique_property ?? "",
    recurring: m?.recurring ?? false,
    time_unit: m?.time_unit ?? "hour",
    filters: Object.entries(m?.filters ?? {}).map(([property, values]) => ({
      property,
      values: values.map(String).join(", "),
    })),
    group_by: m?.group_by ?? [],
    limit_dimensions: m?.limit_dimensions ?? [],
    cost_from: m?.price_list ? "list" : "event",
    provider_mode: m?.price_list?.provider_key ? "property" : (m?.price_list?.provider ?? ""),
    provider_key: m?.price_list?.provider_key ?? "provider",
    model_key: m?.price_list?.model_key ?? "model",
    token_mode: m?.price_list?.token_type ?? "property",
    token_type_key: m?.price_list?.token_type_key ?? "token_type",
    cost_currency: m?.cost_currency ?? "",
  };
}

/** The `price_list` mapping the Cost section posts; "" when the meter is not mapped. */
function priceListWire(v: Values): string {
  if (v.cost_from !== "list") return "";
  return JSON.stringify({
    ...(v.provider_mode === "property"
      ? { provider_key: v.provider_key.trim() }
      : v.provider_mode
        ? { provider: v.provider_mode }
        : {}),
    model_key: v.model_key.trim() || "model",
    ...(v.token_mode === "property"
      ? { token_type_key: v.token_type_key.trim() }
      : { token_type: v.token_mode }),
  });
}

/** Meter create and edit. A meter with usage keeps its definition: only the name can change. */
export function MeterForm({
  biz,
  meter,
  crumbs,
  returnTo,
  providers = [],
  currencies = [],
}: {
  biz: string;
  /** present → edit mode */
  meter?: Meter | null;
  crumbs: Crumb[];
  returnTo: string;
  /** Providers in the model price list, for the Cost section. */
  providers?: string[];
  /** The business's currencies, for the cost currency. */
  currencies?: string[];
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const editing = !!meter;
  const locked = !!meter?.locked;
  const [v, set, setAll] = useFormModel(seedOf(meter), formRef);
  const agg = v.aggregation;
  const keyError = editing ? undefined : slugError(v.key, "ai_tokens");

  const counts =
    agg === "count"
      ? "the number of events"
      : agg === "unique"
        ? `the different values of ${v.unique_property || "a property"}`
        : `${meterAggregationLabel(agg).toLowerCase()} of ${v.value_property || "a property"}`;
  const lead = v.event_name
    ? `We bill ${counts} from “${v.event_name}” events${v.group_by.length ? `, for each ${v.group_by.join(" and ")}` : ""}.`
    : "Enter the event name to see what this meter counts.";

  return (
    <ActionForm
      action={editing ? updateMeterAction : createMeterAction}
      onSuccess={(r) => router.push(r.redirectTo ?? returnTo)}
      formRef={formRef}
    >
      <input type="hidden" name="biz" value={biz} />
      {editing ? (
        <>
          <input type="hidden" name="meter" value={meter!.id} />
          {meter!.resource_version != null ? (
            <input type="hidden" name="expected_version" value={meter!.resource_version} />
          ) : null}
          {locked ? <input type="hidden" name="locked" value="1" /> : null}
        </>
      ) : null}
      <input type="hidden" name="cost_present" value="1" />
      <input type="hidden" name="price_list" value={priceListWire(v)} />
      <input
        type="hidden"
        name="limit_dimensions"
        value={JSON.stringify(v.limit_dimensions.filter(Boolean))}
      />
      {locked ? null : (
        <>
          <input
            type="hidden"
            name="filters"
            value={JSON.stringify(v.filters.filter((f) => f.property || f.values))}
          />
          <input type="hidden" name="group_by" value={JSON.stringify(v.group_by.filter(Boolean))} />
        </>
      )}

      <FormFrame
        crumbs={crumbs}
        title={editing ? "Edit meter" : "New meter"}
        description={
          editing
            ? locked
              ? "This meter has usage. You can change its name only. To count events in a different way, create a new meter."
              : "No event or price uses this meter yet, so you can change all of it."
            : "A meter counts the usage events that your app sends. A price on the meter bills what it counts."
        }
        cancelHref={returnTo}
        submitLabel={editing ? "Save changes" : "Create meter"}
        summary={
          <SummaryCard
            lead={lead}
            rows={[
              { label: "Aggregation", value: meterAggregationLabel(agg) },
              {
                label: "Filters",
                value: v.filters.filter((f) => f.property).length
                  ? v.filters
                      .filter((f) => f.property)
                      .map((f) => `${f.property} is ${f.values || "…"}`)
                      .join("; ")
                  : "All events",
              },
              {
                label: "Group by",
                value: v.group_by.filter(Boolean).join(", ") || "None",
              },
              canRecur(agg) && {
                label: "Level",
                value: v.recurring ? "Carries to the next period" : "Starts again each period",
              },
            ]}
            note="Events are never linked to a meter when we receive them. A new meter also counts the events that we already keep."
          />
        }
      >
        <FormCard
          title="Meter"
          actions={
            editing ? null : (
              <button
                type="button"
                className="text-sm font-medium text-primary hover:underline"
                onClick={() =>
                  setAll({
                    ...v,
                    name: AI_TOKENS_PRESET.name,
                    key: AI_TOKENS_PRESET.id,
                    autoKey: false,
                    event_name: AI_TOKENS_PRESET.event_name,
                    aggregation: AI_TOKENS_PRESET.aggregation,
                    value_property: AI_TOKENS_PRESET.value_property,
                    group_by: [...AI_TOKENS_PRESET.group_by],
                    recurring: false,
                  })
                }
              >
                Use the AI tokens setup
              </button>
            )
          }
        >
          <TextField
            name="name"
            label="Name"
            required
            value={v.name}
            maxLength={200}
            onChange={(x) => {
              set("name", x);
              if (!editing && v.autoKey) set("key", suggestSlug(x));
            }}
          />
          {editing ? (
            <LockedField label="Meter ID" value={meter!.id} mono />
          ) : (
            <TextField
              name="key"
              label="Meter ID"
              value={v.key}
              mono
              maxLength={100}
              error={keyError}
              help="We make one from the name. You cannot change it after you create the meter."
              onChange={(x) => {
                set("key", x);
                set("autoKey", false);
              }}
            />
          )}
        </FormCard>

        {locked ? (
          <FormCard title="What it counts · Locked" columns={2}>
            <LockedField label="Event name" value={meter!.event_name} mono />
            <LockedField label="Aggregation" value={meterAggregationLabel(meter!.aggregation)} />
            {meter!.value_property ? (
              <LockedField label="Value property" value={meter!.value_property} mono />
            ) : null}
            {meter!.unique_property ? (
              <LockedField label="Unique property" value={meter!.unique_property} mono />
            ) : null}
            <LockedField
              label="Group by"
              value={meter!.group_by.join(", ") || "None"}
              mono={meter!.group_by.length > 0}
            />
            <Wide>
              <LockedField
                label="Filters"
                value={
                  Object.entries(meter!.filters).length
                    ? Object.entries(meter!.filters)
                        .map(([p, vals]) => `${p} is ${vals.join(", ")}`)
                        .join("; ")
                    : "All events"
                }
                reason="Usage was billed with these values. To count events in a different way, create a new meter."
              />
            </Wide>
          </FormCard>
        ) : (
          <>
            <FormCard title="What it counts">
              <TextField
                name="event_name"
                label="Event name"
                required
                mono
                value={v.event_name}
                maxLength={200}
                help="The event_name that your app sends. More than one meter can read the same events."
                onChange={(x) => set("event_name", x)}
              />
              <Field name="aggregation" label="Aggregation" help={meterAggregationHint(agg)}>
                <SelectField
                  name="aggregation"
                  value={agg}
                  onValueChange={(a) => {
                    set("aggregation", a);
                    if (!canRecur(a)) set("recurring", false);
                  }}
                  ariaLabel="Aggregation"
                  options={METER_AGGREGATIONS.map((a) => ({
                    value: a,
                    label: meterAggregationLabel(a),
                  }))}
                />
              </Field>
              {needsValueProperty(agg) ? (
                <TextField
                  name="value_property"
                  label="Value property"
                  required
                  mono
                  value={v.value_property}
                  maxLength={100}
                  help="The property that holds the number, for example tokens. Up to 12 decimal places."
                  onChange={(x) => set("value_property", x)}
                />
              ) : null}
              {needsUniqueProperty(agg) ? (
                <TextField
                  name="unique_property"
                  label="Unique property"
                  required
                  mono
                  value={v.unique_property}
                  maxLength={100}
                  help="We count the different values of this property, for example user_id."
                  onChange={(x) => set("unique_property", x)}
                />
              ) : null}
              {agg === "weighted_sum" ? (
                <Field
                  name="time_unit"
                  label="Time unit"
                  help="We bill the level multiplied by the hours or days that it stayed."
                >
                  <SelectField
                    name="time_unit"
                    value={v.time_unit}
                    onValueChange={(t) => set("time_unit", t)}
                    ariaLabel="Time unit"
                    options={[
                      { value: "hour", label: "Hour" },
                      { value: "day", label: "Day" },
                    ]}
                  />
                </Field>
              ) : null}
              {canRecur(agg) ? (
                <Wide>
                  <SwitchRow
                    name="recurring"
                    label="Carry the level to the next period"
                    hint="For seats or storage. The level stays until a new event changes it."
                    checked={v.recurring}
                    onCheckedChange={(c) => set("recurring", c)}
                  />
                </Wide>
              ) : null}
            </FormCard>

            <FormCard title="Filters and groups" columns={1}>
              <FilterRows rows={v.filters} onChange={(rows) => set("filters", rows)} />
              <PropertyRows
                field="group_by"
                label="Group by"
                max={MAX_GROUP_BY}
                list={v.group_by}
                onChange={(list) => set("group_by", list)}
                hint={`Up to ${MAX_GROUP_BY} properties, in order. A price on this meter can set a rate for each combination of their values, for example each model and token type.`}
              />
            </FormCard>
          </>
        )}
        <CostCard v={v} set={set} providers={providers} currencies={currencies} />
        <FormCard title="Spend limits" columns={1}>
          <PropertyRows
            field="limit_dimensions"
            label="Limit properties"
            max={MAX_LIMIT_DIMENSIONS}
            list={v.limit_dimensions}
            onChange={(list) => set("limit_dimensions", list)}
            hint={`Up to ${MAX_LIMIT_DIMENSIONS} event properties, for example user. A spend limit can then apply to each value of a property. You can change this after the meter has usage.`}
          />
        </FormCard>
      </FormFrame>
    </ActionForm>
  );
}

function FilterRows({ rows, onChange }: { rows: FilterRow[]; onChange: (r: FilterRow[]) => void }) {
  const error = useFieldError("filters");
  const upd = (i: number, patch: Partial<FilterRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <span id="filters" className="text-sm font-medium">
        Filters
      </span>
      {rows.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_2rem] gap-2 text-xs text-muted-foreground">
          <span>Property</span>
          <span>Values, separated by commas</span>
          <span />
        </div>
      ) : null}
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_2rem] items-center gap-2"
        >
          <Input
            aria-label={`Filter ${i + 1} property`}
            value={r.property}
            maxLength={100}
            className="font-mono"
            onChange={(e) => upd(i, { property: e.target.value })}
          />
          <Input
            aria-label={`Filter ${i + 1} values`}
            value={r.values}
            className="font-mono"
            onChange={(e) => upd(i, { values: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove filter ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="text-sm font-medium text-primary hover:underline"
          onClick={() => onChange([...rows, { property: "", values: "" }])}
        >
          + Add filter
        </button>
      </div>
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          An event counts only when each property in the list has one of its values. With no
          filters, every event with this name counts.
        </p>
      )}
    </div>
  );
}

function PropertyRows({
  field,
  label,
  max,
  list,
  hint,
  onChange,
}: {
  field: string;
  label: string;
  max: number;
  list: string[];
  hint: string;
  onChange: (l: string[]) => void;
}) {
  const error = useFieldError(field);
  return (
    <div className="flex flex-col gap-2">
      <span id={field} className="text-sm font-medium">
        {label}
      </span>
      {list.map((p, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-2">
          <Input
            aria-label={`${label} property ${i + 1}`}
            value={p}
            maxLength={100}
            className="font-mono"
            onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label.toLowerCase()} property ${i + 1}`}
            onClick={() => onChange(list.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      {list.length < max ? (
        <div>
          <button
            type="button"
            className="text-sm font-medium text-primary hover:underline"
            onClick={() => onChange([...list, ""])}
          >
            + Add property
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** Cost section (design G1b § 5.3): where cost and the model price list key come from. */
function CostCard({
  v,
  set,
  providers,
  currencies,
}: {
  v: Values;
  set: <K extends keyof Values>(k: K, value: Values[K]) => void;
  providers: string[];
  currencies: string[];
}) {
  const priceListError = useFieldError("price_list");
  const cur = Array.from(
    new Set(["USD", ...currencies.map((c) => c.toUpperCase()), v.cost_currency].filter(Boolean)),
  );
  const fixedProvider = v.provider_mode && v.provider_mode !== "property" ? v.provider_mode : null;
  return (
    <FormCard title="Cost">
      <Wide>
        <Field
          name="cost_from"
          label="Cost from"
          help={
            v.cost_from === "list"
              ? "An event's own cost comes first. For an event without one, we use your cost, else the model price list. A price on this meter can then bill from the model price list."
              : "We use the cost field of each event. An event without one has no cost."
          }
        >
          <SelectField
            value={v.cost_from}
            onValueChange={(x) => set("cost_from", x === "list" ? "list" : "event")}
            ariaLabel="Cost from"
            options={[
              { value: "event", label: "Event cost" },
              { value: "list", label: "Model price list" },
            ]}
          />
        </Field>
      </Wide>
      {v.cost_from === "list" ? (
        <>
          <Field
            name="model_key"
            label="Model property"
            help="The event property that holds the model name. Add it to Group by."
          >
            <Input
              value={v.model_key}
              maxLength={100}
              className="font-mono"
              onChange={(e) => set("model_key", e.target.value)}
            />
          </Field>
          <Field
            name="provider_mode"
            label="Provider"
            help={
              v.provider_mode === ""
                ? "We find the provider from the model. If more than one provider has the model, it has no price."
                : undefined
            }
          >
            <SelectField
              value={v.provider_mode}
              onValueChange={(x) => set("provider_mode", x)}
              ariaLabel="Provider"
              options={[
                { value: "", label: "Find from the model" },
                { value: "property", label: "From property" },
                ...Array.from(
                  new Set([...providers, ...(fixedProvider ? [fixedProvider] : [])]),
                ).map((p) => ({ value: p, label: p })),
              ]}
            />
          </Field>
          {v.provider_mode === "property" ? (
            <Field name="provider_key" label="Provider property" help="Add it to Group by.">
              <Input
                value={v.provider_key}
                maxLength={100}
                className="font-mono"
                onChange={(e) => set("provider_key", e.target.value)}
              />
            </Field>
          ) : null}
          <Field name="token_mode" label="Token type">
            <SelectField
              value={v.token_mode}
              onValueChange={(x) => set("token_mode", x)}
              ariaLabel="Token type"
              options={[
                { value: "property", label: "From property" },
                ...Array.from(
                  new Set([...TOKEN_TYPES, ...(v.token_mode !== "property" ? [v.token_mode] : [])]),
                ).map((t) => ({ value: t, label: t })),
              ]}
            />
          </Field>
          {v.token_mode === "property" ? (
            <Field name="token_type_key" label="Token type property" help="Add it to Group by.">
              <Input
                value={v.token_type_key}
                maxLength={100}
                className="font-mono"
                onChange={(e) => set("token_type_key", e.target.value)}
              />
            </Field>
          ) : null}
        </>
      ) : null}
      <Field
        name="cost_currency"
        label="Cost currency"
        help="The currency of the cost field on events that do not name one."
      >
        <SelectField
          name="cost_currency"
          value={v.cost_currency}
          onValueChange={(x) => set("cost_currency", x)}
          ariaLabel="Cost currency"
          options={[
            { value: "", label: "The currency of the price" },
            ...cur.map((c) => ({ value: c, label: c })),
          ]}
        />
      </Field>
      {priceListError ? (
        <Wide>
          <p className="text-xs font-medium text-destructive">{priceListError}</p>
        </Wide>
      ) : null}
    </FormCard>
  );
}
