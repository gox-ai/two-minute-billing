"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { SettingRow } from "@/components/settings/settings-layout";
import {
  GRACE_UNITS,
  USAGE_CLOSE_BASE_MINUTES,
  effectiveGraceByInterval,
  formatGrace,
  graceMinutesFrom,
  graceUnitFor,
  graceUnitMax,
  intervalLabel,
  type GraceUnit,
} from "@/lib/usage-grace";

const per = (u: GraceUnit) => GRACE_UNITS.find((x) => x.value === u)!.minutes;
const INVALID = "Enter a whole number of minutes, hours, or days, up to 30 days.";
// Written out here so the screen map sees the option labels.
const UNIT_OPTIONS: Array<{ value: GraceUnit; label: string }> = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
];

/**
 * The usage grace window: a number and a unit. Both post as typed and the save action turns
 * them into minutes with the same function as here, so a value the screen refuses is never
 * saved. The consequence follows what is typed, and names the plans whose period lowers it.
 */
export function UsageCloseDelayRow({
  defaultValue,
  intervals,
}: {
  defaultValue: number;
  /** The billing periods of the business's recurring prices. */
  intervals: Array<{ unit: string; count: number }>;
}) {
  const [unit, setUnit] = useDefaultState<GraceUnit>(graceUnitFor(defaultValue));
  const [text, setText] = useDefaultState(String(defaultValue / per(graceUnitFor(defaultValue))));
  const minutes = graceMinutesFrom(text, unit);
  const capped = minutes
    ? effectiveGraceByInterval(minutes, intervals).filter((i) => i.capped)
    : [];
  // The browser refuses the submit while the value is out of range.
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    inputRef.current?.setCustomValidity(minutes == null ? INVALID : "");
  }, [minutes]);

  return (
    <SettingRow
      label="Wait before the invoice finalizes"
      htmlFor="usage_close_delay_value"
      help="The renewal starts on time. Only the invoice of the period that closed waits, and its charge waits with it. Plan credits also start on time, unless Credit availability is When the invoice is paid."
      errorFor="usage_close_delay_value"
      control={
        <div className="flex flex-col gap-1.5">
          <span className="inline-flex flex-wrap items-center gap-2">
            <Input
              ref={inputRef}
              id="usage_close_delay_value"
              name="usage_close_delay_value"
              type="number"
              inputMode="numeric"
              min={0}
              max={graceUnitMax(unit)}
              step={1}
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Wait before the invoice finalizes"
              aria-invalid={minutes == null || undefined}
              aria-describedby={minutes == null ? "usage_close_delay_value-invalid" : undefined}
              className="w-30 text-right tabular-nums"
            />
            <SelectField
              name="usage_close_delay_unit"
              options={UNIT_OPTIONS}
              value={unit}
              onValueChange={(v) => setUnit(v as GraceUnit)}
              ariaLabel="Unit of the wait"
              className="w-30"
            />
          </span>
          {/* An invalid value is an error, not an outcome: it shows here, not in the consequence. */}
          {minutes == null ? (
            <p
              id="usage_close_delay_value-invalid"
              className="m-0 text-xs font-medium text-destructive"
            >
              {INVALID}
            </p>
          ) : null}
        </div>
      }
      consequence={
        minutes == null
          ? undefined
          : minutes === 0
            ? `An invoice with metered usage finalizes about ${USAGE_CLOSE_BASE_MINUTES} minutes after its period ends.`
            : [
                `An invoice with metered usage finalizes about ${formatGrace(USAGE_CLOSE_BASE_MINUTES + minutes)} after its period ends. Then we charge it.`,
                ...capped.map(
                  (c) =>
                    `For plans billed every ${intervalLabel(c.unit, c.count)}, the wait is ${formatGrace(c.minutes)}: never more than half the billing period.`,
                ),
              ].join(" ")
      }
      more="Use a wait if your app sends usage events late. An event that arrives in the wait goes on the invoice of its own period. An event that arrives after the invoice finalizes goes on the next invoice. An invoice with only fixed fees does not wait. The wait is also never more than half the new period."
    />
  );
}
