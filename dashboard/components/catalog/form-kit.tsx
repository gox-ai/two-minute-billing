"use client";

import * as React from "react";
import Link from "next/link";
import { useDefaultState } from "@/lib/use-default-state";
import { COUPON_CODE_RE } from "@/lib/limits";
import { RecordCrumbs, RecordCard, Facts } from "@/components/patterns/record-page";
import type { Crumb } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SwitchField } from "@/components/ui/switch";
import { SelectField } from "@/components/ui/select-field";
import { SubmitButton } from "@/components/form/submit-button";
import { Field } from "@/components/form/field";
import { useFieldError } from "@/components/form/action-form";
import { currencyExponent, majorStep, toMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { metaJson, type MetaRow } from "@/lib/metadata-rows";
import { MetadataRows } from "@/components/form/metadata-rows";

/**
 * Shared pieces of the catalog create/edit forms: page frame with a live summary
 * beside the fields, cards, a sticky Cancel + primary footer, and fully controlled
 * field state that survives React 19's post-action form reset.
 */

// ── State ──────────────────────────────────────────────────────────────────────

/**
 * One controlled object per form. Seeded from server data and re-seeded when that
 * data changes (`useDefaultState`, compared by JSON so a fresh object each render is
 * not a change). React 19 resets the form after every action, and Radix controls
 * report their mount-time value back through their change callbacks; the values
 * captured at submit are put back once that has happened, so a failed save keeps
 * what was typed and a successful one never reverts.
 */
export function useFormModel<T extends object>(
  seed: T,
  formRef: React.RefObject<HTMLFormElement | null>,
) {
  const [values, setValues] = useDefaultState<T>(seed, (v) => JSON.stringify(v));
  const latest = React.useRef(values);
  React.useEffect(() => {
    latest.current = values;
  });

  React.useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    let atSubmit: T | null = null;
    const onSubmit = () => {
      atSubmit = latest.current;
    };
    const onReset = () => {
      const snap = atSubmit ?? latest.current;
      queueMicrotask(() => setValues(snap));
    };
    form.addEventListener("submit", onSubmit, true);
    form.addEventListener("reset", onReset);
    return () => {
      form.removeEventListener("submit", onSubmit, true);
      form.removeEventListener("reset", onReset);
    };
  }, [formRef, setValues]);

  const set = React.useCallback(
    <K extends keyof T>(key: K, value: T[K]) =>
      setValues((prev) => (Object.is(prev[key], value) ? prev : { ...prev, [key]: value })),
    [setValues],
  );
  return [values, set, setValues] as const;
}

// ── Page frame ─────────────────────────────────────────────────────────────────

export function FormFrame({
  crumbs,
  title,
  description,
  summary,
  footerNote = (
    <>
      Fields marked <span className="text-destructive">*</span> are required
    </>
  ),
  cancelHref,
  submitLabel,
  children,
}: {
  crumbs: Crumb[];
  title: React.ReactNode;
  description?: React.ReactNode;
  summary: React.ReactNode;
  footerNote?: React.ReactNode;
  cancelHref: string;
  submitLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <RecordCrumbs items={crumbs} />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-[-0.02em] wrap-break-word">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        <aside className="min-w-0 xl:sticky xl:top-4">{summary}</aside>
      </div>
      <div className="sticky bottom-0 z-10 -mx-5 -mb-8 flex flex-wrap items-center gap-3 border-t bg-card px-5 py-3 md:-mx-10 md:-mb-10 md:px-10">
        <p className="text-xs text-muted-foreground">{footerNote}</p>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href={cancelHref}>Cancel</Link>
          </Button>
          <SubmitButton>{submitLabel}</SubmitButton>
        </div>
      </div>
    </div>
  );
}

/** A form card: titled, body laid out as a two-column field grid. */
export function FormCard({
  title,
  meta,
  actions,
  children,
  columns = 2,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  columns?: 1 | 2 | 3;
}) {
  return (
    <RecordCard title={title} meta={meta} actions={actions}>
      <div
        className={cn(
          "grid grid-cols-1 gap-x-4 gap-y-5",
          columns === 2 && "sm:grid-cols-2",
          columns === 3 && "sm:grid-cols-3",
        )}
      >
        {children}
      </div>
    </RecordCard>
  );
}

/** Spans the whole card row. */
export function Wide({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 sm:col-span-full">{children}</div>;
}

export function SummaryCard({
  lead,
  rows,
  note,
  children,
}: {
  lead: React.ReactNode;
  rows: Array<{ label: React.ReactNode; value: React.ReactNode } | null | false | undefined>;
  note?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <RecordCard title="Summary">
      <div className="flex flex-col gap-4">
        <p
          aria-live="polite"
          className="rounded-md bg-info-soft px-4 py-3 text-sm font-semibold wrap-break-word tabular-nums"
        >
          {lead}
        </p>
        <Facts rows={rows} />
        {children}
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
    </RecordCard>
  );
}

// ── Fields ─────────────────────────────────────────────────────────────────────

/** A value fixed after create: read-only, with the reason it cannot change. */
export function LockedField({
  label,
  value,
  reason,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  reason?: React.ReactNode;
  mono?: boolean;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium">
        {label} <span className="font-normal text-muted-foreground">· Locked</span>
      </Label>
      <div
        id={id}
        aria-readonly="true"
        className={cn(
          "flex h-9 items-center rounded-md border border-input bg-muted/50 px-3 text-sm wrap-anywhere",
          mono && "font-mono",
        )}
      >
        {value}
      </div>
      {reason ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
    </div>
  );
}

/** A switch with its label and one-line consequence. */
export function SwitchRow({
  name,
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  name?: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const labelId = React.useId();
  return (
    <div className="flex items-start gap-3">
      <SwitchField
        name={name}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        ariaLabel={typeof label === "string" ? label : undefined}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
}

export interface Choice {
  value: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}

/** Radio options as bordered cards — for a small set of consequential choices. */
export function ChoiceCards({
  name,
  value,
  onValueChange,
  options,
  ariaLabel,
  columns = 2,
}: {
  name?: string;
  value: string;
  onValueChange: (v: string) => void;
  options: Choice[];
  ariaLabel: string;
  columns?: 2 | 3;
}) {
  const base = React.useId();
  return (
    <>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <RadioGroup
        value={value}
        onValueChange={onValueChange}
        aria-label={ariaLabel}
        className={cn(
          "grid grid-cols-1 gap-2",
          columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3",
        )}
      >
        {options.map((o) => {
          const id = `${base}-${o.value}`;
          const on = o.value === value;
          return (
            <label
              key={o.value}
              htmlFor={id}
              className={cn(
                "flex min-w-0 items-start gap-3 rounded-md border bg-card px-3 py-2.5",
                on ? "border-primary bg-info-soft" : "border-border",
                o.disabled ? "opacity-50" : "cursor-pointer",
              )}
            >
              <RadioGroupItem id={id} value={o.value} disabled={o.disabled} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{o.label}</span>
                {o.hint ? <span className="text-xs text-muted-foreground">{o.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </>
  );
}

/**
 * Controlled money field in MAJOR units that posts integer minor units under `name`.
 * Same look as `MoneyInput`; controlled so the summary reads the live value and the
 * form reset cannot desync it. Blank posts ''.
 */
export function MoneyField({
  name,
  id,
  currency,
  value,
  onChange,
  required,
  placeholder,
  className,
  "aria-invalid": ariaInvalid,
  "aria-describedby": describedBy,
}: {
  name?: string;
  id?: string;
  currency: string;
  /** Major units as typed. */
  value: string;
  onChange: (major: string) => void;
  required?: boolean;
  placeholder?: string;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const exponent = currencyExponent(currency);
  return (
    <div
      className={cn(
        "flex h-9 items-center rounded-md border border-input bg-transparent",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        ariaInvalid && "border-destructive focus-within:border-destructive",
        className,
      )}
    >
      <input
        id={id ?? name}
        type="number"
        inputMode="decimal"
        step={majorStep(currency)}
        min={0}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={ariaInvalid ? true : undefined}
        aria-describedby={describedBy}
        placeholder={placeholder ?? (exponent === 0 ? "0" : (0).toFixed(exponent))}
        className="w-full min-w-0 flex-1 self-stretch rounded-l-md bg-transparent pl-3 text-sm tabular-nums outline-none placeholder:text-muted-foreground"
      />
      <span className="px-3 text-sm font-medium text-muted-foreground select-none">{currency}</span>
      {name ? <input type="hidden" name={name} value={majorToMinor(value, currency)} /> : null}
    </div>
  );
}

/** '' for blank or unparseable, so the server reports the problem instead of storing 0. */
export function majorToMinor(major: string, currency: string): string {
  const s = major.trim();
  if (s === "") return "";
  const n = Number(s);
  return Number.isFinite(n) ? String(toMinor(n, currency)) : "";
}

// ── Metadata ───────────────────────────────────────────────────────────────────

export { metaRows, metaJson, type MetaRow } from "@/lib/metadata-rows";
/**
 * Key/value editor posting one JSON object under `metadata` (blank = none), plus
 * `metadata_present` so an edit can tell "cleared" from "not on this form".
 */
export function MetadataEditor({
  rows,
  onChange,
}: {
  rows: MetaRow[];
  onChange: (rows: MetaRow[]) => void;
}) {
  const serverError = useFieldError("metadata");
  const { json, error } = metaJson(rows);
  return (
    <div className="flex flex-col gap-2">
      <span id="metadata" className="text-sm font-medium">
        JSON metadata
      </span>
      <input type="hidden" name="metadata_present" value="1" />
      <input type="hidden" name="metadata" value={json} />
      <MetadataRows rows={rows} onChange={onChange} />
      {error || serverError ? (
        <p className="text-xs font-medium text-destructive">{error ?? serverError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The API returns it with this record. Billing does not use it.
        </p>
      )}
    </div>
  );
}

// ── Frequencies ────────────────────────────────────────────────────────────────

export type Interval = "day" | "week" | "month" | "year";
export const INTERVALS: Interval[] = ["month", "year", "week", "day"];

export function everyLabel(interval: string, count: number): string {
  return `Every ${count} ${interval}${count === 1 ? "" : "s"}`;
}

/** "every month" / "every 3 months" — for summary sentences. */
export function everyPhrase(interval: string, count: number): string {
  return count === 1 ? `every ${interval}` : `every ${count} ${interval}s`;
}

export function adjective(interval: string, count: number): string {
  if (count !== 1) return `every ${count} ${interval}s`;
  return { day: "daily", week: "weekly", month: "monthly", year: "yearly" }[interval] ?? interval;
}

/**
 * Frequency picker. With a business allow-list it offers exactly those (the engine
 * refuses anything else); without one, any interval × count.
 */
export function FrequencyField({
  allowed,
  interval,
  count,
  onChange,
  prefix = "",
}: {
  allowed?: Array<{ interval: Interval; count: number }> | null;
  interval: string;
  count: string;
  onChange: (interval: string, count: string) => void;
  prefix?: string;
}) {
  return (
    <>
      <input type="hidden" name={`${prefix}interval`} value={interval} />
      <input type="hidden" name={`${prefix}interval_count`} value={count} />
      {allowed && allowed.length > 0 ? (
        <FrequencySelect
          id={`${prefix}interval`}
          allowed={allowed}
          interval={interval}
          count={count}
          onChange={onChange}
        />
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Every</span>
          <Input
            aria-label="Frequency count"
            type="number"
            min={1}
            value={count}
            onChange={(e) => onChange(interval, e.target.value)}
            className="w-20 tabular-nums"
          />
          <IntervalSelect
            id={`${prefix}interval`}
            value={interval}
            onChange={(v) => onChange(v, count)}
          />
        </div>
      )}
    </>
  );
}

function FrequencySelect({
  id,
  allowed,
  interval,
  count,
  onChange,
}: {
  id: string;
  allowed: Array<{ interval: Interval; count: number }>;
  interval: string;
  count: string;
  onChange: (interval: string, count: string) => void;
}) {
  return (
    <SelectField
      id={id}
      ariaLabel="Frequency"
      value={`${count}:${interval}`}
      onValueChange={(v) => {
        const [c, i] = v.split(":");
        onChange(i!, c!);
      }}
      options={allowed.map((f) => ({
        value: `${f.count}:${f.interval}`,
        label: everyLabel(f.interval, f.count),
      }))}
    />
  );
}

function IntervalSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <SelectField
      id={id}
      ariaLabel="Billing interval"
      value={value}
      onValueChange={onChange}
      className="w-32"
      options={INTERVALS.map((i) => ({ value: i, label: `${i}(s)` }))}
    />
  );
}

/** Pick a default frequency: the requested one if allowed, else the first allowed, else 1 month. */
export function defaultFrequency(
  allowed: Array<{ interval: Interval; count: number }> | null | undefined,
  wanted?: string,
): { interval: string; count: string } {
  const list = allowed ?? [];
  if (wanted) {
    const hit = list.find((f) => f.interval === wanted && f.count === 1);
    if (hit || list.length === 0) return { interval: wanted, count: "1" };
  }
  const monthly = list.find((f) => f.interval === "month" && f.count === 1);
  const first = monthly ?? list[0];
  return first
    ? { interval: first.interval, count: String(first.count) }
    : { interval: "month", count: "1" };
}

// ── Small helpers ──────────────────────────────────────────────────────────────

export function TextField({
  name,
  label,
  value,
  onChange,
  help,
  required,
  error,
  maxLength,
  placeholder,
  mono,
  className,
  inputClassName,
  type,
}: {
  name: string;
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  help?: React.ReactNode;
  required?: boolean;
  error?: string;
  maxLength?: number;
  placeholder?: string;
  mono?: boolean;
  className?: string;
  inputClassName?: string;
  type?: string;
}) {
  return (
    <Field
      name={name}
      label={label}
      help={help}
      required={required}
      error={error}
      className={className}
    >
      <Input
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        className={cn(mono && "font-mono", type === "number" && "tabular-nums", inputClassName)}
      />
    </Field>
  );
}

export const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Live check for an id field; undefined when blank or valid. */
export function slugError(v: string, example: string): string | undefined {
  const s = v.trim();
  if (!s || SLUG_OK.test(s)) return undefined;
  return `Use only letters, digits, dots, dashes or underscores. Do not use spaces. For example, ${example}.`;
}

/** Live check for a coupon code; undefined when blank or valid. */
export function couponCodeError(v: string, example: string): string | undefined {
  const s = v.trim();
  if (!s || COUPON_CODE_RE.test(s)) return undefined;
  return `Use only letters, digits, underscores or hyphens. Do not use spaces or dots. For example, ${example}.`;
}

/** `suggestSlug` with the dots a coupon code cannot hold turned into hyphens. */
export const suggestCouponCode = (name: string) => suggestSlug(name).replace(/\./g, "-");

export function suggestSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 100);
}
