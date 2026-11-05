"use client";

import * as React from "react";
import { Check, ChevronDown, CalendarRange, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Calendar, parseYmd, todayYmd, type DateRange, type Ymd } from "@/components/ui/calendar";
import { useNavPending } from "@/components/navigation/nav-pending";
import { useDefaultState } from "@/lib/use-default-state";

/**
 * The board's window, how finely it is cut, and a custom period — in ONE control.
 *
 * The period and the grain were two rows of segmented links. Two controls implies two
 * decisions, and the second is subordinate: grain only means anything once a period is
 * chosen, and on most boards there is only one grain to have.
 *
 * ⚠️ GRAIN IS NOT A PERIOD. "Daily" once sat in the period list, where it answered a
 * different question — how finely, not how far back.
 *
 * A PRESET is a named range the ENGINE resolves (`30d`, `this_month`, …), so its window is
 * whatever the engine says it is; a CUSTOM period sends explicit `start`/`end` calendar
 * dates, which the engine takes directly. Presets are therefore links computed on the
 * server, while a custom pick is built here — its URL is not one of a list.
 *
 * ⚠️ NO RESOLVED DATES BESIDE THE PRESET LABELS. Computing "Last 30 days = Aug 11 – Sep 9"
 * in the browser would be a SECOND implementation of the engine's calendar, and the two
 * would disagree the first time one of them changed. The window actually used is shown on
 * the trigger, read off the answer.
 */

export interface BoardOption {
  id: string;
  label: string;
  href: string;
}

/**
 * `2026-08-11` → `11 Aug 2026`, for a window someone has to read at a glance.
 *
 * Takes a calendar date OR an instant: the URL carries `YYYY-MM-DD` (what we send), while
 * the engine reports its resolved window as a timestamp. Both render the same way.
 */
/** Days in an inclusive calendar range. */
function spanDays(start: Ymd, end: Ymd): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

function pretty(d: string): string {
  const dt = parseYmd(d) ?? (Number.isNaN(Date.parse(d)) ? null : new Date(d));
  if (!dt) return d;
  return dt.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const MONTH_ABBR = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** `YYYY-MM-DD` → `DD/MM/YYYY`, the form the date fields show and accept. */
function toField(d: Ymd | null): string {
  return d ? `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "";
}

/**
 * A typed date → `YYYY-MM-DD`, or null. Takes `DD/MM/YYYY` (also `-` or `.`), `YYYY-MM-DD`, and
 * `11 Aug 2026` — the form the trigger shows, so a pasted label works too.
 */
export function parseTypedDate(raw: string): Ymd | null {
  const s = raw.trim().toLowerCase();
  const two = (n: string) => n.padStart(2, "0");
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m)
    return parseYmd(`${m[3]}-${two(m[2]!)}-${two(m[1]!)}`)
      ? `${m[3]}-${two(m[2]!)}-${two(m[1]!)}`
      : null;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m)
    return parseYmd(`${m[1]}-${two(m[2]!)}-${two(m[3]!)}`)
      ? `${m[1]}-${two(m[2]!)}-${two(m[3]!)}`
      : null;
  m = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*,?\s+(\d{4})$/);
  if (m) {
    const mi = MONTH_ABBR.indexOf(m[2]!);
    if (mi < 0) return null;
    const out = `${m[3]}-${two(String(mi + 1))}-${two(m[1]!)}`;
    return parseYmd(out) ? out : null;
  }
  return null;
}

/**
 * One end of the range, typed. The field keeps whatever is being typed and commits a date only
 * once it parses and fits; a bad entry is named on blur rather than silently dropped.
 */
function DateField({
  id,
  label,
  value,
  onCommit,
  validate,
}: {
  id: string;
  label: string;
  value: Ymd | null;
  onCommit: (d: Ymd | null) => void;
  /** Why a parsed date cannot be used here, or null. */
  validate: (d: Ymd) => string | null;
}) {
  // A calendar click re-seeds the field and clears a stale error; typing does not fight it,
  // since a valid entry IS `value`.
  const [text, setText] = useDefaultState(toField(value));
  const [error, setError] = useDefaultState<string | null>(null, () => value);

  const check = (raw: string, final: boolean) => {
    if (raw.trim() === "") {
      setError(null);
      if (final) onCommit(null);
      return;
    }
    const d = parseTypedDate(raw);
    const why = d ? validate(d) : "Use DD/MM/YYYY";
    if (d && !why) {
      setError(null);
      onCommit(d);
    } else if (final) setError(why);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={text}
        inputMode="numeric"
        placeholder="DD/MM/YYYY"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          check(e.target.value, false);
        }}
        onBlur={(e) => check(e.target.value, true)}
        className="h-8 tabular-nums"
      />
      {error ? (
        <span id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function BoardRangePicker({
  ranges,
  range,
  grains,
  grain,
  basePath,
  carry,
  custom,
  resolved,
}: {
  ranges: BoardOption[];
  range: string;
  /** Empty when every measure on this board answers at one grain — then no group shows. */
  grains: BoardOption[];
  grain: string;
  /** Where a custom window's URL is built from, since it cannot be one of a list. */
  basePath: string;
  /** Params a custom window must preserve (`dash`, `grain`). */
  carry: Record<string, string>;
  /** The custom window in the URL, when there is one. */
  custom: DateRange;
  /** The window the ENGINE actually answered over, for the trigger. */
  resolved: { start: string; end: string } | null;
}) {
  const { navigate, pendingFrom } = useNavPending();
  const pending = pendingFrom("period");
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<DateRange>(custom);

  // Re-seed when the URL's window changes underneath — the popover is long-lived and a
  // draft left over from a previous open would apply someone else's dates.
  React.useEffect(() => setDraft(custom), [custom.start, custom.end]);

  const isCustom = custom.start != null && custom.end != null;
  const currentGrain = grains.find((g) => g.id === grain);
  const label = isCustom
    ? `${pretty(custom.start!)} – ${pretty(custom.end!)}`
    : (ranges.find((r) => r.id === range)?.label ?? "Period");

  const go = (href: string) => {
    setOpen(false);
    navigate(href, { source: "period" });
  };
  const today = todayYmd();
  const startIssue = (d: Ymd) =>
    d > today
      ? "Cannot be in the future"
      : draft.end && d > draft.end
        ? "After the end date"
        : null;
  const endIssue = (d: Ymd) =>
    d > today
      ? "Cannot be in the future"
      : draft.start && d < draft.start
        ? "Before the start date"
        : null;

  const applyCustom = () => {
    if (!draft.start || !draft.end) return;
    const p = new URLSearchParams({ ...carry, start: draft.start, end: draft.end });
    go(`${basePath}?${p.toString()}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="bg-card">
          {pending ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
          ) : (
            <CalendarRange className="size-3.5 text-muted-foreground" />
          )}
          {label}
          {currentGrain ? (
            <span className="text-muted-foreground">· {currentGrain.label}</span>
          ) : null}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-(--radix-popover-content-available-height) w-auto max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-y-auto p-0 md:flex-row"
      >
        {/* Presets read down the left, the calendar sits to their right — the same shape as
            the control it replaces, so the common choice stays one click. */}
        <div className="flex shrink-0 flex-col p-2 md:w-44">
          <span className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Period
          </span>
          {ranges.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => go(r.href)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span className="flex-1 truncate">{r.label}</span>
              {!isCustom && r.id === range ? <Check className="size-3.5" /> : null}
            </button>
          ))}

          {grains.length > 1 ? (
            <>
              <Separator className="my-2" />
              <span className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Grain
              </span>
              {grains.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => go(g.href)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm capitalize hover:bg-accent"
                >
                  <span className="flex-1 truncate">{g.label}</span>
                  {g.id === grain ? <Check className="size-3.5" /> : null}
                </button>
              ))}
            </>
          ) : null}
        </div>

        <Separator orientation="vertical" className="hidden h-auto md:block" />
        <Separator className="md:hidden" />

        {/* Two grids, one per end, each with a field that takes a typed date — picking a start and
            an end months apart is two clicks, not a paging exercise in one grid. */}
        <form
          className="p-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyCustom();
          }}
        >
          <span className="mb-2 block text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Custom period
          </span>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-col gap-3">
              <DateField
                id="range-start"
                label="Start date"
                value={draft.start}
                validate={startIssue}
                onCommit={(d) => setDraft((r) => ({ ...r, start: d }))}
              />
              <Calendar value={draft} onChange={setDraft} select="start" />
            </div>
            <div className="flex flex-col gap-3">
              <DateField
                id="range-end"
                label="End date"
                value={draft.end}
                validate={endIssue}
                onCommit={(d) => setDraft((r) => ({ ...r, end: d }))}
              />
              <Calendar value={draft} onChange={setDraft} select="end" />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {draft.start && draft.end
                ? `${pretty(draft.start)} – ${pretty(draft.end)} · ${spanDays(draft.start, draft.end)} days`
                : draft.start
                  ? "Now select the end date"
                  : "Select the start date"}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft({ start: null, end: null })}
                disabled={!draft.start && !draft.end}
              >
                Clear
              </Button>
              <Button type="submit" size="sm" disabled={!draft.start || !draft.end}>
                Apply
              </Button>
            </div>
          </div>
          {/* What the figures actually cover, which is the engine's answer and not our
              arithmetic — a preset's window is only knowable once it has been resolved. */}
          {resolved ? (
            <p className="mt-2 text-xs text-muted-foreground tabular-nums">
              Showing {pretty(resolved.start)} – {pretty(resolved.end)}
            </p>
          ) : null}
        </form>
      </PopoverContent>
    </Popover>
  );
}
