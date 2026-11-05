"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { SelectField } from "@/components/ui/select-field";
import { useDefaultState, useFormResetSync } from "@/lib/use-default-state";
import type { HubSpotFieldMapping } from "@/lib/api/hubspot";

type Direction = HubSpotFieldMapping["direction"];

const DIRECTION_LABEL: Record<Direction, string> = {
  to_remote: "Send to HubSpot",
  to_local: "Take from HubSpot",
  both: "Both ways",
};

const LIMIT = 15;

interface Row extends HubSpotFieldMapping {
  key: number;
}

const seed = (rows: HubSpotFieldMapping[]): Row[] => rows.map((r, i) => ({ ...r, key: i }));

/**
 * Rows of HubSpot property ↔ our field ↔ direction. Posts every complete row as one JSON array
 * in a hidden input named `name`; the server action parses it.
 */
export function FieldMappingEditor({
  name,
  defaultRows,
  remoteOptions,
  localOptions,
  directions = ["to_remote", "to_local", "both"],
  remoteLabel = "HubSpot property",
  localLabel = "Our field",
}: {
  name: string;
  defaultRows: HubSpotFieldMapping[];
  /** Properties that may be written; a saved row whose property is missing keeps its own option. */
  remoteOptions: ComboboxOption[];
  localOptions: ComboboxOption[];
  directions?: Direction[];
  remoteLabel?: string;
  localLabel?: string;
}) {
  const [rows, setRows] = useDefaultState(seed(defaultRows), (r) =>
    JSON.stringify(r.map(({ key: _k, ...m }) => m)),
  );
  const root = React.useRef<HTMLDivElement>(null);
  // React resets the form after the action; Radix then replays mount-time values into our rows.
  useFormResetSync(root, () => setRows(seed(defaultRows)));

  const update = (key: number, patch: Partial<HubSpotFieldMapping>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const withSaved = (options: ComboboxOption[], value: string) =>
    !value || options.some((o) => o.value === value)
      ? options
      : [{ value, label: value }, ...options];

  const complete = rows
    .filter((r) => r.remote && r.local)
    .map(({ remote, local, direction }) => ({ remote, local, direction }));

  return (
    <div ref={root} className="space-y-2">
      <input type="hidden" name={name} value={JSON.stringify(complete)} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No fields mapped.</p>
      ) : null}
      {rows.map((r) => (
        <div key={r.key} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Combobox
            size="sm"
            className="sm:w-64"
            ariaLabel={remoteLabel}
            placeholder={remoteLabel}
            options={withSaved(remoteOptions, r.remote)}
            value={r.remote}
            onValueChange={(v) => update(r.key, { remote: v })}
          />
          <Combobox
            size="sm"
            className="sm:w-56"
            ariaLabel={localLabel}
            placeholder={localLabel}
            options={withSaved(localOptions, r.local)}
            value={r.local}
            onValueChange={(v) => update(r.key, { local: v })}
          />
          {directions.length > 1 ? (
            <SelectField
              size="sm"
              className="sm:w-44"
              ariaLabel="Direction"
              options={directions.map((d) => ({ value: d, label: DIRECTION_LABEL[d] }))}
              value={r.direction}
              onValueChange={(v) => update(r.key, { direction: v as Direction })}
            />
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove mapping"
            onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= LIMIT}
          onClick={() =>
            setRows((rs) => [
              ...rs,
              {
                key: rs.reduce((m, x) => Math.max(m, x.key + 1), 0),
                remote: "",
                local: "",
                direction: directions[0] ?? "to_remote",
              },
            ])
          }
        >
          <Plus aria-hidden />
          Add field
        </Button>
        <span className="text-xs text-muted-foreground">
          {rows.length} of {LIMIT}
        </span>
      </div>
    </div>
  );
}
