"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { CheckboxField } from "@/components/ui/checkbox";
import { Consequence } from "@/components/settings/settings-layout";

type Freq = { interval: "day" | "week" | "month" | "year"; count: number };

// The standard frequencies offered as toggles. A business's current custom frequencies
// (not in this list) are merged in as additional checked rows so nothing is silently
// dropped.
const STANDARD: Array<Freq & { label: string }> = [
  { interval: "day", count: 1, label: "Daily" },
  { interval: "week", count: 1, label: "Weekly" },
  { interval: "day", count: 14, label: "14 Days" },
  { interval: "month", count: 1, label: "Monthly" },
  { interval: "month", count: 3, label: "Quarterly" },
  { interval: "month", count: 6, label: "Half-yearly" },
  { interval: "year", count: 1, label: "Yearly" },
  { interval: "year", count: 10, label: "10 Years" },
];

const key = (f: Freq) => `${f.interval}:${f.count}`;
const labelFor = (f: Freq) =>
  `${f.count > 1 ? `${f.count} ` : ""}${f.interval}${f.count > 1 ? "s" : ""}`;

/**
 * The allow-list as a checkbox grid; posts one `billing_frequencies` = "interval:count"
 * per checked box. None checked = no restriction. The consequence follows the live picks.
 */
export function BillingFrequenciesField({ defaultValue }: { defaultValue?: Freq[] | null }) {
  const current = React.useMemo(() => defaultValue ?? [], [defaultValue]);
  // Rows = standard options + any custom current frequency not already standard.
  const rows = React.useMemo(() => {
    const std = STANDARD.map((s) => ({ ...s }));
    const stdKeys = new Set(std.map(key));
    const extras = current
      .filter((f) => !stdKeys.has(key(f)))
      .map((f) => ({ ...f, label: labelFor(f) }));
    return [...std, ...extras];
  }, [current]);

  const [selected, setSelected] = useDefaultState<Set<string>>(new Set(current.map(key)), (s) =>
    [...s].sort().join(","),
  );

  const toggle = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const picked = rows.filter((f) => selected.has(key(f))).map((f) => f.label);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 min-[400px]:grid-cols-2 sm:grid-cols-3">
        {rows.map((f) => {
          const k = key(f);
          const checked = selected.has(k);
          return (
            <div key={k} className="flex min-h-8 items-center text-sm">
              <CheckboxField checked={checked} onCheckedChange={() => toggle(k)} label={f.label} />
              {/* Emit the selected frequency for the server action to parse. */}
              {checked ? <input type="hidden" name="billing_frequencies" value={k} /> : null}
            </div>
          );
        })}
      </div>
      <Consequence>
        {picked.length === 0
          ? "None checked: a recurring price may use any frequency."
          : `New recurring prices may use only: ${picked.join(", ")}.`}
      </Consequence>
    </div>
  );
}
