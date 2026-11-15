"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useBusinessTz } from "@/components/business-tz";
import {
  dateOnlyToUtcISO,
  todayInTz,
  tzLabel,
  utcToDateValue,
  utcToWallClockValue,
  wallClockToUtcISO,
} from "@/lib/tz";

/**
 * THE date/time entry field. Every dated form control in the dashboard goes through this
 * — there is no correct way to hand-roll one.
 *
 * The operator sees and types a **business-timezone** wall clock (the zone is named in a
 * help line under the input); the form submits the **UTC** instant under `name` via a
 * hidden input. Same shape as `MoneyInput`: human units visible, wire units hidden.
 * Width: fills its column; a standalone field passes a width on the scale (`w-72`).
 *
 * WHY. `<input type="datetime-local">` produces a zone-LESS `2026-08-21T00:00`. Whoever
 * calls `new Date()` on that resolves it in their own zone — the Node process's in a
 * server action, the viewer's in the browser — and neither is the business's. Every dated
 * write on an Asia/Kolkata business was landing 5h30m off, which on a day-anchored
 * business is a different billing day: wrong term end, wrong proration boundary, wrong
 * scheduled-change date. Prefills had the mirror-image bug, derived from `getHours()`
 * (browser) or `toISOString()` (UTC) instead of the business's clock.
 *
 * The zone comes from `useBusinessTz()`, so a field added later is correct for free.
 * Outside a business scope that context is null and the field is UTC — honest, since no
 * single business zone applies there.
 */
export function DateTimeField({
  name,
  /** `datetime` (default) collects a day + time; `date` collects a day, meaning 00:00 in the business zone. */
  granularity = "datetime",
  /** Prefill: a UTC ISO string or Date from the API. Rendered in the business zone. */
  defaultValue,
  required,
  disabled,
  id,
  className,
  min,
  max,
  /** Restrict to today or later, in the BUSINESS zone (not the viewer's). */
  minToday,
  /** Called with the UTC ISO string ('' when blank/unparseable) — for modals that post via JS. */
  onUtcChange,
  /** Hide the zone hint. Only for a field whose label already names the zone. */
  hideZoneHint,
  tz: zone,
  "aria-describedby": describedBy,
}: {
  /**
   * Submitted field name, receiving the UTC ISO instant. Omit inside a dialog that
   * collects the value in JS via `onUtcChange` rather than posting a form.
   */
  name?: string;
  granularity?: "date" | "datetime";
  defaultValue?: string | Date | null;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Bound as a business-zone wall-clock value (same format as the visible input). */
  min?: string;
  max?: string;
  minToday?: boolean;
  onUtcChange?: (utcIso: string) => void;
  hideZoneHint?: boolean;
  /** The zone to enter in, when not the business's: an org-wide record uses `useDisplayTz()`. */
  tz?: string | null;
  "aria-describedby"?: string;
}) {
  const businessTz = useBusinessTz();
  const tz = zone !== undefined ? zone : businessTz;
  const dateOnly = granularity === "date";

  const toLocalValue = React.useCallback(
    (v?: string | Date | null) => (dateOnly ? utcToDateValue(v, tz) : utcToWallClockValue(v, tz)),
    [dateOnly, tz],
  );

  const [local, setLocal] = React.useState(() => toLocalValue(defaultValue));

  // The business zone arrives from context on the client, and a prefill can also be
  // re-supplied by the parent (picking a plan re-derives a trial end). Re-render the
  // visible value from the UTC source in both cases — otherwise the field keeps a wall
  // clock computed against the wrong zone.
  const defaultKey =
    defaultValue instanceof Date ? defaultValue.toISOString() : (defaultValue ?? "");
  React.useEffect(() => {
    setLocal(toLocalValue(defaultValue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultKey, toLocalValue]);

  const utcIso = React.useMemo(() => {
    if (!local) return "";
    // Opening a dialog and submitting WITHOUT editing must be a no-op. A
    // `datetime-local` input only has minute precision, so a stored end-of-day boundary
    // (…T18:29:59.999Z) renders as `23:59` and converts back to …T18:29:00.000Z — the
    // form would silently walk the term end back 60s every time it was opened. So while
    // the visible wall clock still matches the prefill's, emit the prefill's own instant;
    // any actual edit falls through to the typed value.
    if (defaultValue && local === toLocalValue(defaultValue)) {
      const d = defaultValue instanceof Date ? defaultValue : new Date(defaultValue);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return (dateOnly ? dateOnlyToUtcISO(local, tz) : wallClockToUtcISO(local, tz)) ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, dateOnly, tz, defaultKey, toLocalValue]);

  React.useEffect(() => {
    onUtcChange?.(utcIso);
  }, [utcIso, onUtcChange]);

  const zoneId = React.useId();
  // Names the zone the value is read in, which is the business's unless `tz` overrides it.
  const zoneName = tz || "UTC";
  const offset = tzLabel(tz);
  const zoneText = `${zone === undefined && businessTz ? "Business time zone" : "Time zone"}: ${zoneName}${offset !== zoneName ? ` (${offset})` : ""}`;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <input
        id={id}
        type={dateOnly ? "date" : "datetime-local"}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        required={required}
        disabled={disabled}
        min={minToday ? todayInTz(tz) : min}
        max={max}
        aria-describedby={
          [describedBy, hideZoneHint ? null : zoneId].filter(Boolean).join(" ") || undefined
        }
        // Empty: the browser's format hint reads as a placeholder, not as a value.
        data-empty={local ? undefined : ""}
        className={cn(
          "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-empty:text-muted-foreground",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
          className,
        )}
      />
      {hideZoneHint ? null : (
        <p id={zoneId} className="m-0 text-xs text-muted-foreground">
          {zoneText}
        </p>
      )}
      {/* The wire value: always UTC, always zone-qualified. Empty when the field is blank
          or unparseable, so the server's own validation reports it rather than receiving a
          silently shifted instant. */}
      {name ? <input type="hidden" name={name} value={utcIso} /> : null}
    </div>
  );
}
