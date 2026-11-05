"use client";

import * as React from "react";
import { Check, ChevronDown, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { SelectField } from "@/components/ui/select-field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { utcToDateValue } from "@/lib/tz";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * A field's kind, which drives the operator list and the value control.
 *
 * `money` is `number` plus a unit: the operator types 1,299.00 and the filter sends
 * 129900, because every amount in this system is integer minor units. A list may only
 * use it when a single exponent is right for every row — otherwise the field stays
 * `number` and says "minor units" in its own label, which is honest rather than
 * convenient.
 */
export type ListFilterType = "text" | "select" | "number" | "money" | "date" | "boolean";

/** One field offered by the filter builder. */
export interface ListFilterField<T> {
  id: string;
  /** Display label, e.g. "Customer Id". */
  label: string;
  /** Defaults to `'text'`. */
  type?: ListFilterType;
  /**
   * Section this field is filed under in the picker — "Customer", "Amounts", "Dates".
   * With 30+ fields per list an ungrouped alphabetical list is unusable; the picker
   * shows the group beside each row and searches it too.
   */
  group?: string;
  /** Required for `'select'`; ignored otherwise. */
  options?: { value: string; label: string }[];
  /**
   * Pulls the comparable value off a row (client-side filtering). Server mode
   * doesn't call this — the API applies the filter — so it's optional there.
   */
  value?: (row: T) => unknown;
  /** API field name for server mode. Defaults to `id`. */
  param?: string;
  /** Operators the endpoint supports for this field (server mode). */
  serverOps?: string[];
  /** `money` only: minor-unit exponent. 2 for INR/USD, 0 for JPY. Defaults to 2. */
  moneyExponent?: number;
  /** Muted note under the value control — units, or what a value means. */
  hint?: string;
  /** Extra search terms in the field picker (an alias, an old name). */
  keywords?: string;
}

/** One `field[op]=value` filter as the list API takes it. */
export interface ListServerFilter {
  field: string;
  op: string;
  value: string;
}

// ── Operators ─────────────────────────────────────────────────────────────────

/**
 * Client operator ids are the SERVER's ids, deliberately — `src/platform/list-query.ts`
 * TEXT_OPS/NUMBER_OPS/DATE_OPS. One vocabulary means no translation table to drift, and
 * a `serverOps` allow-list can be compared directly.
 *
 * The two exceptions are `is_empty` / `is_not_empty`, which are UI spellings of the one
 * server operator `is_present` with a boolean value. Presenting one operator as two rows
 * reads far better than "is present: No".
 */
export type Operator =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "on"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  | "in_last"
  | "in_next"
  | "is_empty"
  | "is_not_empty";

interface OperatorDef {
  id: Operator;
  label: string;
  /** No value control (`is empty`). */
  unary?: boolean;
  /** Comma-separated set — the value control is a multi-picker. */
  set?: boolean;
  /** Two bounds, comma-separated. */
  range?: boolean;
  /** A count of days rather than a value of the field's own kind. */
  days?: boolean;
}

const TEXT_OPERATORS: OperatorDef[] = [
  { id: "contains", label: "contains" },
  { id: "not_contains", label: "does not contain" },
  { id: "is", label: "is" },
  { id: "is_not", label: "is not" },
  { id: "starts_with", label: "starts with" },
  { id: "ends_with", label: "ends with" },
  { id: "in", label: "is one of", set: true },
  { id: "not_in", label: "is none of", set: true },
  { id: "is_empty", label: "is empty", unary: true },
  { id: "is_not_empty", label: "is not empty", unary: true },
];

const SELECT_OPERATORS: OperatorDef[] = [
  { id: "is", label: "is" },
  { id: "is_not", label: "is not" },
  { id: "in", label: "is one of", set: true },
  { id: "not_in", label: "is none of", set: true },
  { id: "is_empty", label: "is empty", unary: true },
  { id: "is_not_empty", label: "is not empty", unary: true },
];

const NUMBER_OPERATORS: OperatorDef[] = [
  { id: "is", label: "is" },
  { id: "is_not", label: "is not" },
  { id: "gt", label: "is greater than" },
  { id: "gte", label: "is at least" },
  { id: "lt", label: "is less than" },
  { id: "lte", label: "is at most" },
  { id: "between", label: "is between", range: true },
  { id: "is_empty", label: "is empty", unary: true },
  { id: "is_not_empty", label: "is not empty", unary: true },
];

const DATE_OPERATORS: OperatorDef[] = [
  { id: "on", label: "is on" },
  { id: "after", label: "is after" },
  { id: "on_or_after", label: "is on or after" },
  { id: "before", label: "is before" },
  { id: "on_or_before", label: "is on or before" },
  { id: "between", label: "is between", range: true },
  { id: "in_last", label: "is in the last", days: true },
  { id: "in_next", label: "is in the next", days: true },
  { id: "is_empty", label: "is empty", unary: true },
  { id: "is_not_empty", label: "is not empty", unary: true },
];

export const OPERATORS: Record<ListFilterType, OperatorDef[]> = {
  text: TEXT_OPERATORS,
  select: SELECT_OPERATORS,
  number: NUMBER_OPERATORS,
  money: NUMBER_OPERATORS,
  date: DATE_OPERATORS,
  boolean: [{ id: "is", label: "is" }],
};

const BOOLEAN_OPTIONS = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

export function fieldType<T>(field?: ListFilterField<T>): ListFilterType {
  return field?.type ?? "text";
}

export function operatorsFor<T>(
  field: ListFilterField<T> | undefined,
  server: boolean,
): OperatorDef[] {
  const all = OPERATORS[fieldType(field)];
  if (!server || !field?.serverOps) return all;
  const allowed = field.serverOps;
  // The unary pair is one server operator, so it is offered when `is_present` is.
  const ops = all.filter(
    (o) => allowed.includes(o.id) || (o.unary && allowed.includes("is_present")),
  );
  return ops.length > 0 ? ops : [all[0]!];
}

function opDef<T>(
  field: ListFilterField<T> | undefined,
  op: Operator,
  server: boolean,
): OperatorDef {
  const ops = operatorsFor(field, server);
  return ops.find((o) => o.id === op) ?? ops[0]!;
}

// ── Money ─────────────────────────────────────────────────────────────────────

const exponentOf = <T,>(field?: ListFilterField<T>) => field?.moneyExponent ?? 2;

/** Minor units → the major-unit string the operator edits. */
function minorToMajor(minor: string, exponent: number): string {
  if (minor === "") return "";
  const n = Number(minor);
  if (!Number.isFinite(n)) return "";
  return exponent === 0 ? String(n) : (n / 10 ** exponent).toFixed(exponent);
}

/**
 * The major-unit string → minor units. Rounded rather than truncated: `12.999` typed
 * into an amount box means 13.00, and `Math.trunc` would send 1299 — a filter bound one
 * cent below what the operator asked for, which silently changes which rows match.
 */
function majorToMinor(major: string, exponent: number): string {
  if (major.trim() === "") return "";
  const n = Number(major);
  if (!Number.isFinite(n)) return "";
  return String(Math.round(n * 10 ** exponent));
}

// ── Client-side evaluation ────────────────────────────────────────────────────

/**
 * The BUSINESS-timezone day (YYYY-MM-DD) of a value that may be an ISO timestamp or a
 * date, for comparison against a day the operator picked in a date filter.
 *
 * Must not be the UTC day: a subscription created 21-Aug 00:30 IST is stored as
 * 20-Aug 19:00Z, so bucketing by UTC day made "created on 21-Aug" silently skip it —
 * the row is visible in the list, dated 21-Aug, and the filter drops it.
 */
function businessDay(v: unknown, tz: string | null): string | null {
  if (v == null || v === "") return null;
  const t = new Date(String(v)).getTime();
  return Number.isNaN(t) ? null : utcToDateValue(new Date(t), tz);
}

/** Today in the business's zone, as the day the relative operators count from. */
function todayInBusiness(tz: string | null): string {
  return utcToDateValue(new Date(), tz) ?? new Date().toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` shifted by whole days, without touching local time. */
function shiftDay(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

const splitMulti = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");

/**
 * Evaluate one committed filter row against one source row's value.
 *
 * Mirrors `filterSql` in `src/platform/list-query.ts` operator for operator, including
 * the inclusive-both-ends `between` and the today-inclusive relative windows. The two
 * implementations must agree: a client-side list and a server-backed one showing
 * different rows for the same named filter is the bug that makes an operator stop
 * trusting every list in the product.
 */
export function matches(
  raw: unknown,
  op: Operator,
  input: string,
  type: ListFilterType,
  tz: string | null,
  exponent = 2,
): boolean {
  const isEmpty = raw == null || raw === "";
  if (op === "is_empty") return isEmpty;
  if (op === "is_not_empty") return !isEmpty;
  if (input === "") return true; // half-filled row — don't narrow anything

  if (type === "number" || type === "money") {
    const a = Number(raw);
    if (!Number.isFinite(a)) return false;
    const asMinor = (v: string) =>
      type === "money" ? Number(majorToMinor(v, exponent)) : Number(v);
    if (op === "between") {
      const [lo, hi] = splitMulti(input).map(asMinor);
      if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      const [min, max] = lo <= hi ? [lo, hi] : [hi, lo];
      return a >= min && a <= max;
    }
    if (op === "in" || op === "not_in") {
      const members = splitMulti(input).map(asMinor);
      const hit = members.includes(a);
      return op === "in" ? hit : !hit;
    }
    const b = asMinor(input);
    if (!Number.isFinite(b)) return false;
    switch (op) {
      case "gt":
        return a > b;
      case "gte":
        return a >= b;
      case "lt":
        return a < b;
      case "lte":
        return a <= b;
      case "is_not":
        return a !== b;
      default:
        return a === b;
    }
  }

  if (type === "date") {
    const a = businessDay(raw, tz);
    if (!a) return false;
    if (op === "between") {
      const [from, to] = splitMulti(input);
      if (!from || !to) return false;
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return a >= lo && a <= hi;
    }
    if (op === "in_last" || op === "in_next") {
      const n = Number(input);
      if (!Number.isInteger(n) || n <= 0) return false;
      const today = todayInBusiness(tz);
      // Both windows INCLUDE today and are n whole days wide — the same convention
      // `filterSql`'s `todayPlus()` uses.
      return op === "in_last"
        ? a >= shiftDay(today, -(n - 1)) && a <= today
        : a >= today && a <= shiftDay(today, n - 1);
    }
    switch (op) {
      case "after":
        return a > input;
      case "on_or_after":
        return a >= input;
      case "before":
        return a < input;
      case "on_or_before":
        return a <= input;
      default:
        return a === input;
    }
  }

  if (type === "boolean") {
    const a = String(Boolean(raw));
    return op === "is_not" ? a !== input : a === input;
  }

  const a = String(raw ?? "").toLowerCase();
  if (op === "in" || op === "not_in") {
    const hit = splitMulti(input).some((m) => m.toLowerCase() === a);
    return op === "in" ? hit : !hit;
  }
  const b = input.toLowerCase();
  switch (op) {
    case "is":
      return a === b;
    case "is_not":
      return a !== b;
    case "starts_with":
      return a.startsWith(b);
    case "ends_with":
      return a.endsWith(b);
    case "not_contains":
      return !a.includes(b);
    default:
      return a.includes(b);
  }
}

// ── Rows, and the server/URL wire form ────────────────────────────────────────

export interface FilterRow {
  key: number;
  field: string;
  op: Operator;
  value: string;
}

/** Is this row worth applying? A blank value narrows nothing and must not be sent. */
export function rowIsUsable<T>(
  row: FilterRow,
  field: ListFilterField<T> | undefined,
  server: boolean,
): boolean {
  if (!row.field || !field) return false;
  const def = opDef(field, row.op, server);
  if (def.unary) return true;
  if (def.range) return splitMulti(row.value).length === 2;
  if (def.set) return splitMulti(row.value).length > 0;
  return row.value.trim() !== "";
}

/**
 * Builder rows → the `field/op/value` triples the API and the URL take.
 *
 * `money` rows convert here and nowhere else: the operator edits major units, and every
 * consumer downstream — the endpoint, a saved view, a shared link — sees minor units, so
 * a view saved from the UI and one written by an API caller mean the same thing.
 */
export function toServerFilters<T>(
  rows: FilterRow[],
  fieldsById: Record<string, ListFilterField<T>>,
  server: boolean,
): ListServerFilter[] {
  const out: ListServerFilter[] = [];
  for (const r of rows) {
    const field = fieldsById[r.field];
    if (!field || !rowIsUsable(r, field, server)) continue;
    const def = opDef(field, r.op, server);
    const param = field.param ?? field.id;
    if (def.unary) {
      out.push({ field: param, op: "is_present", value: r.op === "is_empty" ? "false" : "true" });
      continue;
    }
    const value =
      fieldType(field) === "money"
        ? splitMulti(r.value)
            .map((v) => majorToMinor(v, exponentOf(field)))
            .join(",")
        : r.value;
    out.push({ field: param, op: r.op, value });
  }
  return out;
}

/**
 * The inverse — a stored view, or a URL, back into builder rows.
 *
 * Filters naming a field this list does not offer are DROPPED, and so are operators the
 * field does not support: a URL cannot be trusted to name a real column, and a saved
 * view may outlive the field it was built on. Dropping is right because the alternative
 * is a row the operator cannot see, edit, or clear that silently narrows the list.
 */
export function fromServerFilters<T>(
  filters: ListServerFilter[],
  fields: ListFilterField<T>[],
  server: boolean,
  startKey = -1,
): FilterRow[] {
  const byParam = new Map(fields.map((f) => [f.param ?? f.id, f]));
  const out: FilterRow[] = [];
  /**
   * Identical triples collapse to one row.
   *
   * A page can legitimately hand the SAME filter in twice. `urlFilters()` reads both the
   * legacy per-param form (`?status=failure`, still used by several deep links) and the
   * generic `?filter=status:is:failure` that the list itself now writes back — so as soon
   * as an operator touched a legacy-deep-linked list, its URL carried both spellings and
   * the next load produced TWO identical pills over one condition. On the wire they
   * already collapsed (`listQuery` keys params by `field[op]`), so this was cosmetic —
   * but two pills for one filter is a UI that cannot be reasoned about, and removing one
   * of them would leave the list still narrowed.
   */
  const seen = new Set<string>();
  let key = startKey;
  for (const f of filters) {
    const field = byParam.get(f.field);
    if (!field) continue;
    const allowed = operatorsFor(field, server);
    // `is_present` arrives as one operator and is edited as two rows.
    const op: Operator =
      f.op === "is_present"
        ? f.value === "false"
          ? "is_empty"
          : "is_not_empty"
        : (f.op as Operator);
    const def = allowed.find((o) => o.id === op);
    if (!def) continue;
    const value = def.unary
      ? ""
      : fieldType(field) === "money"
        ? splitMulti(f.value)
            .map((v) => minorToMajor(v, exponentOf(field)))
            .join(",")
        : f.value;
    const dedupeKey = `${field.id}\u0000${op}\u0000${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ key: key--, field: field.id, op, value });
  }
  return out;
}

/** A one-line human reading of a row, for the applied-filter pills. */
export function describeFilter<T>(
  row: FilterRow,
  field: ListFilterField<T> | undefined,
  server: boolean,
): string {
  if (!field) return "";
  const def = opDef(field, row.op, server);
  if (def.unary) return `${field.label} ${def.label}`;
  if (def.days) return `${field.label} ${def.label} ${row.value} days`;
  const parts = splitMulti(row.value);
  const labelOf = (v: string) =>
    fieldType(field) === "boolean"
      ? (BOOLEAN_OPTIONS.find((o) => o.value === v)?.label ?? v)
      : (field.options?.find((o) => o.value === v)?.label ?? v);
  if (def.range) return `${field.label} ${def.label} ${parts.map(labelOf).join(" and ")}`;
  if (def.set) {
    const shown = parts.slice(0, 2).map(labelOf).join(", ");
    return `${field.label} ${def.label} ${shown}${parts.length > 2 ? ` +${parts.length - 2}` : ""}`;
  }
  return `${field.label} ${def.label} ${labelOf(row.value)}`;
}

// ── Value controls ────────────────────────────────────────────────────────────

/**
 * Multi-value picker for a `select` field under `is one of`.
 *
 * A Popover of checkboxes rather than a native multiple-choice dropdown: the native one
 * is a build failure here (`pnpm verify:ui`), and a comma-typed text box for a closed set
 * invites `activ` — a value that matches nothing and looks like a bug in the list.
 */
function MultiSelectValue({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const selected = React.useMemo(() => new Set(splitMulti(value)), [value]);
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Emitted in the OPTIONS' order, not click order, so the same selection always
    // produces the same filter string — otherwise two identical views compare unequal
    // and the list refetches for nothing.
    onChange(
      options
        .filter((o) => next.has(o.value))
        .map((o) => o.value)
        .join(","),
    );
  };
  const label =
    selected.size === 0
      ? "Choose…"
      : selected.size === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? "1 selected")
        : `${selected.size} selected`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-w-40 justify-between font-normal"
          aria-label="Filter values"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-56 overflow-y-auto p-1">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No values on this list yet.</p>
        ) : (
          options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Checkbox checked={selected.has(o.value)} tabIndex={-1} aria-hidden />
              <span className="truncate">{o.label}</span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Relative-date shortcuts. Every one compiles to a REAL operator + value, so the row it
 * produces is fully editable and means exactly what it says — no hidden "preset" state
 * that the URL or a saved view could not carry.
 */
function datePresets(tz: string | null): { label: string; op: Operator; value: string }[] {
  const today = todayInBusiness(tz);
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = shiftDay(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  return [
    { label: "Today", op: "on", value: today },
    { label: "Yesterday", op: "on", value: shiftDay(today, -1) },
    { label: "Last 7 days", op: "in_last", value: "7" },
    { label: "Last 30 days", op: "in_last", value: "30" },
    { label: "Last 90 days", op: "in_last", value: "90" },
    { label: "This month", op: "between", value: `${monthStart},${today}` },
    { label: "Last month", op: "between", value: `${lastMonthStart},${lastMonthEnd}` },
    { label: "Next 7 days", op: "in_next", value: "7" },
    { label: "Next 30 days", op: "in_next", value: "30" },
  ];
}

function ValueControl<T>({
  field,
  row,
  server,
  tz,
  onChange,
}: {
  field: ListFilterField<T> | undefined;
  row: FilterRow;
  server: boolean;
  tz: string | null;
  onChange: (patch: Partial<FilterRow>) => void;
}) {
  const type = fieldType(field);
  const def = opDef(field, row.op, server);
  const parts = row.value.split(",");

  if (def.unary) return null;

  if (def.days) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="Filter value"
          type="number"
          min={1}
          step={1}
          value={row.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="7"
          className="h-8 w-20"
        />
        <span className="text-sm text-muted-foreground">days</span>
      </div>
    );
  }

  if (def.range) {
    const inputType = type === "date" ? "date" : "number";
    const set = (i: 0 | 1, v: string) => {
      const next = [parts[0] ?? "", parts[1] ?? ""];
      next[i] = v;
      onChange({ value: next.join(",") });
    };
    return (
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="Filter value from"
          type={inputType}
          value={parts[0] ?? ""}
          onChange={(e) => set(0, e.target.value)}
          placeholder="From"
          className={cn("h-8", inputType === "date" ? "w-36" : "w-28")}
        />
        <span className="text-sm text-muted-foreground">and</span>
        <Input
          aria-label="Filter value to"
          type={inputType}
          value={parts[1] ?? ""}
          onChange={(e) => set(1, e.target.value)}
          placeholder="To"
          className={cn("h-8", inputType === "date" ? "w-36" : "w-28")}
        />
      </div>
    );
  }

  if (def.set) {
    if (type === "select" || type === "boolean") {
      return (
        <MultiSelectValue
          options={type === "boolean" ? BOOLEAN_OPTIONS : (field?.options ?? [])}
          value={row.value}
          onChange={(v) => onChange({ value: v })}
        />
      );
    }
    return (
      <Input
        aria-label="Filter value"
        value={row.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder="value, value, value"
        className="h-8 w-64"
      />
    );
  }

  if (type === "select" || type === "boolean") {
    return (
      <SelectField
        ariaLabel="Filter value"
        size="sm"
        value={row.value}
        onValueChange={(v) => onChange({ value: v })}
        className="min-w-40"
        options={[
          { value: "", label: "Choose…" },
          ...(type === "boolean" ? BOOLEAN_OPTIONS : (field?.options ?? [])),
        ]}
      />
    );
  }

  return (
    <Input
      aria-label="Filter value"
      type={type === "number" || type === "money" ? "number" : type === "date" ? "date" : "text"}
      inputMode={type === "money" ? "decimal" : undefined}
      step={type === "money" ? "any" : undefined}
      value={row.value}
      onChange={(e) => onChange({ value: e.target.value })}
      placeholder="Value"
      className={cn("h-8", type === "date" ? "w-40" : "w-56")}
    />
  );
}

// ── The builder band ──────────────────────────────────────────────────────────

export interface FilterBuilderProps<T> {
  fields: ListFilterField<T>[];
  /** The draft rows being edited. Owned by the caller so Apply/Discard stay its call. */
  draft: FilterRow[];
  onDraftChange: (rows: FilterRow[]) => void;
  onApply: () => void;
  onDiscard: () => void;
  /** Server mode narrows the operator list to what the endpoint implements. */
  server: boolean;
  tz: string | null;
  /** Mints the next row key. */
  nextKey: () => number;
  /** Rendered on the action row — the "Save as view" control belongs here. */
  actions?: React.ReactNode;
}

/**
 * The "Filter list" band: one row per condition, all ANDed.
 *
 * AND-only is deliberate: an OR between arbitrary conditions
 * needs a group/nesting UI, and the cases operators actually reach for — "status is
 * active or in trial", "currency is one of INR, USD" — are exactly what the `is one of`
 * operator expresses on a single row. A saved view holding a flat AND list also stays
 * legible in a URL and in the API's own `field[op]=value` grammar, which a boolean tree
 * would not.
 */
export function FilterBuilder<T>({
  fields,
  draft,
  onDraftChange,
  onApply,
  onDiscard,
  server,
  tz,
  nextKey,
  actions,
}: FilterBuilderProps<T>) {
  const fieldsById = React.useMemo(
    () => Object.fromEntries(fields.map((f) => [f.id, f])),
    [fields],
  );

  /**
   * The field picker is a searchable Combobox, not a plain select: these lists carry
   * 30+ fields, and scrolling a flat alphabetical menu to find "Next Billing At" is the
   * difference between a filter someone uses and one they give up on. `hint` carries the
   * group so the sections are visible without a grouped-menu primitive, and the group is
   * searchable too — typing "amount" finds every amount field.
   */
  const fieldOptions = React.useMemo<ComboboxOption[]>(
    () =>
      fields.map((f) => ({
        value: f.id,
        label: f.label,
        hint: f.group,
        keywords: [f.id, f.group, f.keywords].filter(Boolean).join(" "),
      })),
    [fields],
  );

  const patch = (key: number, p: Partial<FilterRow>) =>
    onDraftChange(draft.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const changeField = (key: number, fieldId: string) => {
    const ops = operatorsFor(fieldsById[fieldId], server);
    patch(key, { field: fieldId, op: ops[0]!.id, value: "" });
  };

  const addRow = () => {
    const field = fields[0];
    onDraftChange([
      ...draft,
      { key: nextKey(), field: field?.id ?? "", op: operatorsFor(field, server)[0]!.id, value: "" },
    ]);
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      {draft.length === 0 ? (
        <p className="text-sm text-muted-foreground">No filters. Add one below.</p>
      ) : null}

      {draft.map((r) => {
        const field = fieldsById[r.field];
        const ops = operatorsFor(field, server);
        const def = opDef(field, r.op, server);
        return (
          <div key={r.key} className="flex flex-wrap items-center gap-2">
            <Combobox
              ariaLabel="Filter field"
              size="sm"
              className="w-56"
              contentClassName="w-72"
              searchPlaceholder="Search fields…"
              value={r.field}
              onValueChange={(v) => changeField(r.key, v)}
              options={fieldOptions}
            />
            <SelectField
              ariaLabel="Filter operator"
              size="sm"
              className="w-auto"
              value={def.id}
              onValueChange={(v) => patch(r.key, { op: v as Operator, value: "" })}
              options={ops.map((o) => ({ value: o.id, label: o.label }))}
            />
            <ValueControl
              field={field}
              row={r}
              server={server}
              tz={tz}
              onChange={(p) => patch(r.key, p)}
            />
            {fieldType(field) === "date" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-primary">
                    Quick pick
                    <ChevronDown className="size-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Relative to today
                  </DropdownMenuLabel>
                  {datePresets(tz)
                    // Only presets whose operator this endpoint actually implements.
                    .filter((p) => ops.some((o) => o.id === p.op))
                    .map((p) => (
                      <DropdownMenuItem
                        key={p.label}
                        onSelect={() => patch(r.key, { op: p.op, value: p.value })}
                      >
                        {p.label}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {field?.hint ? (
              <span className="text-xs text-muted-foreground">{field.hint}</span>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove filter"
              onClick={() => onDraftChange(draft.filter((x) => x.key !== r.key))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="text-primary" onClick={addRow}>
          <Plus className="size-3.5" /> Add Filter
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => onDraftChange([])}
        >
          <Trash2 className="size-3.5" /> Clear all
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button size="sm" onClick={onApply}>
          Apply Filter
        </Button>
        <Button variant="ghost" size="sm" className="text-primary" onClick={onDiscard}>
          Discard
        </Button>
        {actions}
      </div>
    </div>
  );
}

// ── Applied-filter pills ──────────────────────────────────────────────────────

/**
 * The applied conditions, each removable, rendered on the top bar.
 *
 * Showing the narrowing without making you reopen the builder is the whole point: a
 * count ("3 Filters") tells an operator the list is narrowed but not by
 * WHAT, which is how somebody concludes the data is missing rather than filtered.
 */
export function AppliedFilterPills<T>({
  applied,
  fieldsById,
  server,
  onRemove,
}: {
  applied: FilterRow[];
  fieldsById: Record<string, ListFilterField<T>>;
  server: boolean;
  onRemove: (key: number) => void;
}) {
  if (applied.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {applied.map((r) => {
        const text = describeFilter(r, fieldsById[r.field], server);
        if (!text) return null;
        return (
          <span
            key={r.key}
            className="inline-flex max-w-72 items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-xs"
          >
            <span className="truncate" title={text}>
              {text}
            </span>
            <button
              type="button"
              onClick={() => onRemove(r.key)}
              aria-label={`Remove filter: ${text}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Shared with the views dropdown, which marks the selected row the same way. */
export const SelectedCheck = () => <Check className="size-3.5" />;
