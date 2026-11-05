"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { isKnownZone, toModernZone } from "@/lib/tz";

/**
 * IANA timezone picker — searchable, showing each zone's CURRENT offset.
 *
 * WHY IT IS NOT A TEXT INPUT. `businesses.timezone` anchors every date in the product:
 * day-aligned term boundaries (`src/modules/subscriptions/billing-mode.ts`), the
 * business-day bucketing of list date filters, every rendered date (`lib/format.ts`) and
 * every date the operator types (`lib/tz.ts`). A typo in a free-text field does not error —
 * `Intl` throws on an unknown zone and every one of those paths catches and falls back to
 * **UTC**, so `Asia/Calcuta` would silently move an Indian business's billing day by 5h30m.
 * The only safe input is one that cannot produce a value `Intl` does not know.
 *
 * The list comes from `Intl.supportedValuesOf('timeZone')` — the runtime's own tzdb, so it
 * cannot rot the way a hardcoded list would. Offsets are computed live, so each zone reads
 * correctly whichever side of a DST transition today falls on.
 *
 * Uses `Command` inside a `Dialog` (the pattern `set-differential-modal.tsx` already uses)
 * rather than a popover — there is no popover primitive here and this is not worth a new
 * dependency. Submits like a native field via a hidden input, same as `MoneyInput` and
 * `DateTimeField`.
 */

/** Every zone the runtime knows, plus UTC (not always included by `supportedValuesOf`). */
function allZones(): string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    // Very old runtimes: offer UTC + the browser's own zone so the field still works
    // rather than rendering an empty list.
    return [...new Set(["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone])];
  }
}

/** `+05:30` / `-04:00` / `+00:00` — the zone's offset from UTC right now. */
function offsetLabel(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date());
    // longOffset gives `GMT+05:30`, and a bare `GMT` for zero.
    const m = /GMT([+-]\d{2}:\d{2})/.exec(
      parts.find((p) => p.type === "timeZoneName")?.value ?? "",
    );
    return m ? m[1]! : "+00:00";
  } catch {
    return "+00:00";
  }
}

/** Minutes east of UTC, for sorting. */
function offsetMinutes(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

interface Zone {
  id: string;
  offset: string;
  /** The haystack search matches against — zone id, city, region and offset. */
  search: string;
}

export function TimezoneSelect({
  name = "timezone",
  defaultValue,
  placeholder = "Select a time zone…",
  className,
  id,
  description = "Sets the time zone for this business's billing days, invoice dates and every date in the dashboard.",
}: {
  name?: string;
  defaultValue?: string | null;
  placeholder?: string;
  className?: string;
  id?: string;
  /**
   * What this zone actually decides, shown in the picker. Overridable because the
   * ORGANIZATION zone (0216) decides something narrower — how org-scoped screens
   * DISPLAY a timestamp — and telling an admin it anchors billing days would be a
   * label that lies.
   */
  description?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = useDefaultState(defaultValue ?? "");
  // Own the trigger's id rather than relying on `Field`'s clone, which does not reach this
  // component during SSR. See the note in `select-field.tsx`.
  const triggerId = id ?? name;

  // Built once, on the client: ~420 zones × an Intl format each is real work, and the
  // offsets only move at a DST boundary — not during a settings edit.
  const zones = React.useMemo<Zone[]>(() => {
    const raw = allZones();
    // A stored zone can be an alias the runtime does not list (Asia/Kolkata under a Chrome
    // that canonicalizes to Asia/Calcutta). Seed it so the current setting is always
    // selectable rather than reading as an error.
    if (defaultValue && isKnownZone(defaultValue) && !raw.includes(defaultValue))
      raw.push(defaultValue);

    const byId = new Map<string, Zone>();
    for (const zid of raw) {
      // Display and submit the modern name; keep the legacy one searchable.
      const modern = toModernZone(zid);
      const id = isKnownZone(modern) ? modern : zid;
      const offset = offsetLabel(id);
      // MODERN spelling only, in the label AND in what search matches — a legacy name is
      // neither displayed, stored, nor findable.
      const words = new Set([id, id.split("/").pop() ?? id, id.split("/")[0] ?? ""]);
      const search = `${[...words].join(" ")} UTC${offset}`.replace(/_/g, " ").toLowerCase();
      // Two raw ids can collapse onto one modern name; merge their search terms.
      const prev = byId.get(id);
      byId.set(id, { id, offset, search: prev ? `${prev.search} ${search}` : search });
    }
    // By offset, then alphabetically: a merchant who knows their offset but not the IANA
    // name can scan straight to it, which is the common case.
    return [...byId.values()].sort(
      (a, b) => offsetMinutes(a.offset) - offsetMinutes(b.offset) || a.id.localeCompare(b.id),
    );
  }, [defaultValue]);

  // Match either spelling, so a value stored under the legacy name still shows as selected.
  const selected = zones.find((z) => z.id === value || toModernZone(value) === z.id);
  // A stored zone the runtime does not know must stay VISIBLE rather than reading as
  // "unset" — the operator has to be able to see what needs fixing.
  const unknownStored = !!value && !selected;

  return (
    <>
      <button
        type="button"
        id={triggerId}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-left text-sm shadow-xs outline-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30",
          !value && "text-muted-foreground",
          className,
        )}
      >
        <span className="truncate">
          {selected ? (
            <>
              {selected.id.replace(/_/g, " ")}{" "}
              <span className="text-muted-foreground tabular-nums">(UTC{selected.offset})</span>
            </>
          ) : unknownStored ? (
            <span className="text-destructive">{value}: not a known time zone</span>
          ) : (
            placeholder
          )}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* No width class: `size` defaults to `md`, which IS `sm:max-w-lg`. The `max-w-lg`
            that used to be here was dead weight — a media-query utility outranks a bare one,
            so the base always won and this asked for exactly what it already had. */}
        <DialogContent className="p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Time zone</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Command
            // Match our own haystack rather than the rendered label, so "Kolkata", "Asia",
            // "+05:30" and "Calcutta" all find the right row.
            filter={(itemValue, search) => {
              const q = search.toLowerCase().trim();
              if (!q) return 1;
              const z = zones.find((x) => x.id === itemValue);
              return (z?.search ?? itemValue.toLowerCase()).includes(q) ? 1 : 0;
            }}
          >
            <CommandInput placeholder="Search city, region or offset…" autoFocus />
            <CommandList className="max-h-80">
              <CommandEmpty>No matching time zone.</CommandEmpty>
              <CommandGroup>
                {zones.map((z) => (
                  <CommandItem
                    key={z.id}
                    value={z.id}
                    onSelect={() => {
                      setValue(z.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        z.id === selected?.id ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{z.id.replace(/_/g, " ")}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      UTC{z.offset}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {/* The wire value — always an id `Intl` accepts, or empty. */}
      <input type="hidden" name={name} value={value} />
    </>
  );
}
