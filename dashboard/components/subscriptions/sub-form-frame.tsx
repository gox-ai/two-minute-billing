"use client";

import * as React from "react";
import Link from "next/link";
import { RecordCrumbs } from "@/components/patterns/record-page";
import type { Crumb } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useDefaultState, useFormResetSync } from "@/lib/use-default-state";
import { useFieldError } from "@/components/form/action-form";
import { cn } from "@/lib/utils";

/**
 * Page frame for the subscription create/change forms: the catalog form layout
 * (crumbs, title, fields beside a sticky summary on xl, sticky footer), composed
 * locally because the primary action opens a confirm dialog instead of submitting.
 */
export function SubFormFrame({
  crumbs,
  title,
  lead,
  description,
  status,
  aside,
  footerNote,
  footerFigure,
  cancelHref,
  primary,
  children,
}: {
  crumbs: Crumb[];
  title: React.ReactNode;
  /** Above the title (the change form's customer link). */
  lead?: React.ReactNode;
  description?: React.ReactNode;
  /** Errors, under the description. */
  status?: React.ReactNode;
  aside: React.ReactNode;
  footerNote?: React.ReactNode;
  /** The summary's own "due now" figure, shown while the summary is not beside the form. */
  footerFigure?: React.ReactNode;
  cancelHref: string;
  primary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <RecordCrumbs items={crumbs} />
      <div className="flex min-w-0 flex-col gap-1">
        {lead ? <div className="mb-1">{lead}</div> : null}
        <h1 className="text-2xl font-bold tracking-[-0.02em] wrap-break-word">{title}</h1>
        {description ? (
          <div className="text-sm wrap-anywhere text-muted-foreground">{description}</div>
        ) : null}
        {status ? <div className="mt-2">{status}</div> : null}
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4">{aside}</aside>
      </div>
      <div className="sticky bottom-0 z-10 -mx-5 -mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-card px-5 py-3 md:-mx-10 md:-mb-10 md:px-10">
        {footerFigure ? <div className="min-w-0 xl:hidden">{footerFigure}</div> : null}
        {footerNote ? (
          <p className="hidden text-xs text-muted-foreground xl:block">{footerNote}</p>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href={cancelHref}>Cancel</Link>
          </Button>
          {primary}
        </div>
      </div>
    </div>
  );
}

/** "Due now" + the figure, for the footer. */
export function FooterFigure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col leading-tight" aria-live="polite">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

/** A primary label that shortens on a phone, where the footer is shared with the figure. */
export function ShortLabel({ full, short }: { full: string; short: string }) {
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{full}</span>
    </>
  );
}

export interface ChoiceOption {
  value: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}

/**
 * Radio options as bordered cards. Form-safe like `RadioField`: posts through a hidden
 * input under `name`, and drops the mount-time value Radix restores on a form reset.
 */
export function ChoiceCardsField({
  name,
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  options,
  ariaLabel,
  columns = 2,
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  options: ChoiceOption[];
  ariaLabel: string;
  columns?: 2 | 3;
}) {
  const base = React.useId();
  const [internal, setInternal] = useDefaultState(defaultValue);
  const isControlled = controlledValue !== undefined;
  const current = isControlled ? controlledValue : internal;
  const ref = React.useRef<HTMLDivElement>(null);
  const isResetting = useFormResetSync(ref, () => {
    if (!isControlled) setInternal(defaultValue);
  });
  const handle = (next: string) => {
    if (isResetting()) return;
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  };
  return (
    <>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <RadioGroup
        ref={ref}
        value={current}
        onValueChange={handle}
        aria-label={ariaLabel}
        className={cn(
          "grid grid-cols-1 gap-2",
          columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3",
        )}
      >
        {options.map((o) => {
          const id = `${base}-${o.value || "empty"}`;
          const on = o.value === current;
          return (
            <label
              key={o.value || "empty"}
              htmlFor={id}
              className={cn(
                "flex min-w-0 items-start gap-3 rounded-md border bg-card px-3 py-2.5",
                on ? "border-primary bg-info-soft" : "border-border",
                o.disabled ? "opacity-50" : "cursor-pointer",
              )}
            >
              <RadioGroupItem id={id} value={o.value} disabled={o.disabled} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium wrap-break-word">{o.label}</span>
                {o.hint ? (
                  <span className="text-xs wrap-break-word text-muted-foreground">{o.hint}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </>
  );
}

/** A labelled block inside a card, for a control that is not a single `Field` input. */
export function FieldBlock({
  name,
  label,
  help,
  children,
  className,
}: {
  /** The posted field whose server error this block shows. */
  name?: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const error = useFieldError(name ?? "");
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {name && error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : help ? (
        <div className="text-xs text-muted-foreground">{help}</div>
      ) : null}
    </div>
  );
}
