"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { CalendarDays } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar, todayYmd, type Ymd } from "@/components/ui/calendar";
import { parseTypedDate } from "@/components/reports/board-range-picker";
import { fmtDate } from "@/lib/format-date";
import { useDefaultState } from "@/lib/use-default-state";

/**
 * One calendar date in a GET form: shows "10 Nov 2026" like every other date in the app and
 * posts `YYYY-MM-DD` through a hidden input. A native `type="date"` showed the browser's own
 * order (US month first) beside our dates.
 *
 * Typing takes `10 Nov 2026`, `10/11/2026` (day first) or `2026-11-10`; the value commits on
 * blur. A bad entry keeps the last good date in the form and says what to correct.
 */
export function DateInput({
  id,
  name,
  label,
  defaultValue,
  min,
  max,
  tz,
}: {
  id: string;
  name: string;
  /** Names the calendar button: "Select the From date". */
  label: string;
  defaultValue: Ymd;
  min?: Ymd;
  max?: Ymd;
  tz: string | null;
}) {
  const [value, setValue] = useDefaultState(defaultValue);
  const [text, setText] = useDefaultState(fmtDate(defaultValue, tz));
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  const commit = (d: Ymd) => {
    setValue(d);
    setText(fmtDate(d, tz));
    setError(null);
  };

  /** True when the typed text is a usable date (and is now the value). */
  const check = (raw: string): boolean => {
    const d = parseTypedDate(raw);
    const why = !d
      ? "Enter a date, for example 10 Nov 2026."
      : min && d < min
        ? `Select a date on or after ${fmtDate(min, tz)}.`
        : max && d > max
          ? `Select a date on or before ${fmtDate(max, tz)}.`
          : null;
    if (why || !d) {
      setError(why);
      return false;
    }
    commit(d);
    return true;
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <Input
          id={id}
          value={text}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => check(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits the form. Commit the typed date to the hidden input first, or the
            // browser posts the previous one.
            if (e.key !== "Enter") return;
            e.preventDefault();
            const { form, value: raw } = e.currentTarget;
            let ok = false;
            flushSync(() => {
              ok = check(raw);
            });
            if (ok) form?.requestSubmit();
          }}
          className="pr-9 tabular-nums"
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label={`Select the ${label} date`}
            className="absolute top-1/2 right-1 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <CalendarDays className="size-4" aria-hidden />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-3">
            <Calendar
              value={{ start: min ?? null, end: value }}
              select="end"
              max={max ?? todayYmd()}
              onChange={(next) => {
                if (next.end) commit(next.end);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      <input type="hidden" name={name} value={value} />
      {error ? (
        <span id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
