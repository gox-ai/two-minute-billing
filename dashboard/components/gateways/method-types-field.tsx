"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MethodTypeMeta } from "./gateway-meta";

/**
 * Which payment methods this gateway account may be routed. A chip list rather than a
 * toggle stack (it is a restriction on one account, not a per-method feature switch).
 *
 * Submits one hidden `name` input per selected value; with none selected the field is
 * omitted entirely, which the action maps to `null` = no restriction. That mirrors
 * `CurrenciesField` so the two controls in this form behave identically.
 *
 * Choices come from the gateway's catalogue entry (`method_types`), which the engine
 * builds from its adapter's capabilities, so we never offer a method it cannot charge.
 */
export function MethodTypesField({
  available,
  name = "method_types",
  defaultValue,
}: {
  available: MethodTypeMeta[];
  name?: string;
  defaultValue?: string[] | null;
}) {
  const known = React.useMemo(() => new Set(available.map((m) => m.value)), [available]);
  // Keep any stored value the adapter no longer declares (e.g. a method removed from
  // an adapter, or a row written by the API directly) — dropping it silently on save
  // would change routing behind the operator's back.
  const [selected, setSelected] = useDefaultState<string[]>(defaultValue ?? [], (v) => v.join(","));
  // Not offered to buyers yet: never addable. A stored one stays, so a save keeps it.
  const addable = available.filter((m) => !selected.includes(m.value) && m.available !== false);
  const comingSoon = available.filter((m) => m.available === false);

  if (available.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        This gateway has no payment methods to select.
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((v) => {
            const meta = available.find((m) => m.value === v);
            return (
              <span
                key={v}
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs font-medium"
                title={meta?.hint ?? undefined}
              >
                {meta?.label ?? v}
                {!known.has(v) ? (
                  <span className="text-muted-foreground">(not supported)</span>
                ) : meta?.available === false ? (
                  <span className="text-muted-foreground">(coming soon)</span>
                ) : null}
                <input type="hidden" name={name} value={v} />
                <button
                  type="button"
                  aria-label={`Remove ${meta?.label ?? v}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setSelected((s) => s.filter((x) => x !== v))}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">
          No restriction. We can route all methods that this gateway supports to it.
        </span>
      )}
      {addable.length > 0 ? (
        <Select value="" onValueChange={(v) => setSelected((s) => (s.includes(v) ? s : [...s, v]))}>
          <SelectTrigger className="w-64" aria-label="Add a payment method">
            <SelectValue placeholder="Add a payment method…" />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-72">
            {addable.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {comingSoon.length > 0 ? (
        <span className="text-xs text-muted-foreground">
          Coming soon: {comingSoon.map((m) => m.label).join(", ")}.{" "}
          {comingSoon[0]!.unavailable_reason ?? ""}
        </span>
      ) : null}
    </div>
  );
}
