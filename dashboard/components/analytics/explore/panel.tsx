"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";
import { useNavPending } from "@/components/navigation/nav-pending";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/patterns/chip";
import { KPI_LABEL } from "@/components/analytics/layout";
import { exploreHref, PERIOD_ROWS, type Offer } from "./query";
import type { Grain } from "@/lib/analytics-api";

/**
 * The control panel: measures, rows, period, filters — the body of the page's Query card.
 *
 * Every control writes the URL — `navigate` inside the page's transition — so the view stays a
 * shareable link and Back undoes exactly one change. Nothing is held in client state except
 * the measure search box, which selects nothing and belongs to nobody but this browser.
 *
 * An option the engine would refuse is DISABLED with its reason rather than hidden: a builder
 * that silently drops a dimension when you tick a second measure teaches nothing about its own
 * limits.
 */

export interface PanelMeasure {
  id: string;
  name: string;
  description: string;
  checked: boolean;
  /** Why this one cannot be unticked, or what ticking it would cost. */
  note?: string;
  disabled?: boolean;
}

export interface PanelProps {
  basePath: string;
  measures: PanelMeasure[];
  selected: string[];
  dimensions: Offer[];
  dimension: string | null;
  grains: Offer[];
  grain: Grain;
  ranges: Array<{ id: string; label: string }>;
  range: string;
  comparable: boolean;
  compare?: "previous";
  currencies: string[];
  currency?: string;
  /** Named so the currency row can say what the engine reported in when nothing is chosen. */
  reportedIn: string | null;
  /** True where at least one chosen measure is money — a count needs no reporting currency. */
  moneyInPlay: boolean;
}

type SectionKey = "measures" | "dimensions" | "filters" | "period";

function Section({
  title,
  aside,
  pending,
  children,
}: {
  title: string;
  /** Right of the label — the measure count. */
  aside?: React.ReactNode;
  /** A change made in this section is loading. */
  pending?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b px-5 py-4 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`min-w-0 ${KPI_LABEL}`}>{title}</span>
        <span className="flex shrink-0 items-center gap-2">
          {pending ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
          ) : null}
          {aside}
        </span>
      </div>
      {children}
    </div>
  );
}

export function ControlPanel(props: PanelProps) {
  const { navigate, pending, pendingFrom } = useNavPending();
  const busy = (k: SectionKey) => pendingFrom(`explore-${k}`);
  const [needle, setNeedle] = React.useState("");

  const go = (
    from: SectionKey,
    next: {
      measures?: string[];
      dimension?: string | null;
      grain?: Grain;
      range?: string;
      compare?: "previous";
      currency?: string;
    },
  ) => {
    const href = exploreHref(props.basePath, {
      measures: next.measures ?? props.selected,
      dimension: next.dimension === undefined ? props.dimension : next.dimension,
      range: next.range ?? props.range,
      grain: next.grain ?? props.grain,
      compare: "compare" in next ? next.compare : props.compare,
      currency: "currency" in next ? next.currency : props.currency,
    });
    navigate(href, { source: `explore-${from}` });
  };

  const toggle = (id: string, on: boolean) => {
    const measures = on ? [...props.selected, id] : props.selected.filter((m) => m !== id);
    if (measures.length === 0) return;
    go("measures", { measures });
  };

  const shown = React.useMemo(() => {
    const q = needle.trim().toLowerCase();
    if (!q) return props.measures;
    return props.measures.filter((m) => `${m.name} ${m.description}`.toLowerCase().includes(q));
  }, [props.measures, needle]);

  return (
    <div
      className={cn("flex flex-col transition-opacity", pending && "opacity-60")}
      aria-busy={pending}
      data-explore-panel
    >
      <Section
        title="Measures · columns"
        pending={busy("measures")}
        aside={<Chip>{props.selected.length} selected</Chip>}
      >
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            aria-label="Filter measures"
            placeholder="Filter measures"
            className="h-9 bg-card pl-9 text-sm"
          />
        </div>
        <div className="-mx-2 flex max-h-96 flex-col gap-1 overflow-y-auto px-2">
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No measure has the name “{needle.trim()}”.
            </p>
          ) : (
            shown.map((m) => (
              <div key={m.id} className="flex items-start gap-2.5">
                <Checkbox
                  id={`measure-${m.id}`}
                  className="mt-2"
                  checked={m.checked}
                  disabled={m.disabled}
                  onCheckedChange={(next) => toggle(m.id, next === true)}
                />
                {/* The whole text column is the hit area: 32px at least, for a thumb. */}
                <label
                  htmlFor={`measure-${m.id}`}
                  className={cn(
                    "flex min-h-8 min-w-0 flex-1 flex-col justify-center gap-0.5 py-1",
                    m.disabled ? "opacity-50" : "cursor-pointer",
                  )}
                >
                  <span className="text-sm font-medium">{m.name}</span>
                  {m.note ? <span className="text-xs text-muted-foreground">{m.note}</span> : null}
                </label>
              </div>
            ))
          )}
        </div>
      </Section>

      <Section title="Rows" pending={busy("dimensions")}>
        {/* One dimension, not several: `/v1/analytics` splits a measure by ONE `split`, so a
            multi-select here would offer a cut the engine cannot answer. Rows are the periods
            themselves until a dimension is chosen. */}
        <RadioField
          ariaLabel="Rows"
          value={props.dimension ?? PERIOD_ROWS}
          onValueChange={(v) => go("dimensions", { dimension: v === PERIOD_ROWS ? null : v })}
          options={[
            { value: PERIOD_ROWS, label: "Period", hint: "one row per period in the window" },
            ...props.dimensions.map((d) => ({
              value: d.id,
              label: d.label,
              disabled: d.disabled,
              hint: d.reason,
            })),
          ]}
        />
      </Section>

      <Section title="Period" pending={busy("period")}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="explore-window" className="text-xs text-muted-foreground">
            Window
          </label>
          <SelectField
            id="explore-window"
            value={props.range}
            onValueChange={(v) => go("period", { range: v })}
            options={props.ranges.map((r) => ({ value: r.id, label: r.label }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="explore-grain" className="text-xs text-muted-foreground">
            Grain
          </label>
          <SelectField
            id="explore-grain"
            value={props.grain}
            onValueChange={(v) => go("period", { grain: v as Grain })}
            options={props.grains.map((g) => ({
              value: g.id,
              label: g.disabled ? `${g.label}: ${g.reason}` : g.label,
              disabled: g.disabled,
            }))}
          />
        </div>
        {props.comparable ? (
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="explore-compare"
              className="mt-2"
              checked={!!props.compare}
              onCheckedChange={(next) =>
                go("period", { compare: next === true ? "previous" : undefined })
              }
            />
            <label
              htmlFor="explore-compare"
              className="flex min-h-8 flex-1 cursor-pointer items-center py-1 text-sm font-medium"
            >
              Against the window before
            </label>
          </div>
        ) : null}
      </Section>

      <Section title="Filters" pending={busy("filters")}>
        {/* The ONE restriction `/v1/analytics` accepts on the rows it reads. There is no
            `filter[<dimension>]=<value>` parameter — the query schema in
            `src/api/analytics-routes.ts` takes measure, grain, range, start/end, split,
            split_limit, currency, compare and business, and nothing else — so no "add filter"
            control ships. It needs that parameter on the engine first. */}
        {props.moneyInPlay && props.currencies.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="explore-currency" className="text-xs text-muted-foreground">
              Reported in
            </label>
            <SelectField
              id="explore-currency"
              value={props.currency ?? ""}
              onValueChange={(v) => go("filters", { currency: v === "" ? undefined : v })}
              options={[
                {
                  value: "",
                  label: props.reportedIn
                    ? `Engine default (${props.reportedIn})`
                    : "Engine default",
                },
                ...props.currencies.map((c) => ({ value: c, label: c })),
              ]}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            The query reads every row in the window. Row filters are not available yet.
          </p>
        )}
      </Section>
    </div>
  );
}
