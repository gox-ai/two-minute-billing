import * as React from "react";
import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { SelectField } from "@/components/ui/select-field";
import { SwitchField } from "@/components/ui/switch";

/**
 * Settings **detail** page (archetype 6b).
 *
 * Each setting is phrased as a natural-language question on the left, with the
 * current answer on the right as an inline dropdown or a switch — not as a
 * labelled form field. The page should read like a list of decisions the operator
 * has made, not like a form to fill in.
 *
 * Rows do NOT commit on change: there is an explicit Save per page, because these
 * settings persist through form-based server actions and silently mutating a
 * billing default on a stray click is worse than one extra button.
 */

export function SettingsPage({
  title,
  description,
  breadcrumbs,
  learnMoreHref,
  aside,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  breadcrumbs: Array<{ label: string; href?: string }>;
  learnMoreHref?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pb-10">
      {/* Reuse PageHeader rather than rolling our own title — the settings hub uses
          it, and two header treatments inside one section is exactly the drift a
          reviewer notices (different title size, different breadcrumb markup). */}
      <PageHeader title={title} breadcrumbs={breadcrumbs} />

      <div className="flex items-start gap-8">
        <div className="min-w-0 flex-1 space-y-6">
          {description ? (
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {description}{" "}
              {learnMoreHref ? (
                <Link
                  href={learnMoreHref}
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  Learn more
                </Link>
              ) : null}
            </p>
          ) : null}
          {children}
        </div>
        {aside ? <aside className="hidden w-64 shrink-0 xl:block">{aside}</aside> : null}
      </div>
    </div>
  );
}

/** A card of question rows. `title` renders an "Advanced Settings"-style heading above it. */
export function SettingsSection({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-2", className)}>
      {title ? <h2 className="pt-2 text-sm font-semibold text-foreground/80">{title}</h2> : null}
      <div className="divide-y divide-border overflow-hidden rounded-lg border bg-card">
        {children}
      </div>
    </section>
  );
}

/**
 * One setting: the question on the left, the answer control on the right.
 * `note` renders a parenthetical grey caveat under the question.
 */
export function SettingRow({
  question,
  note,
  help,
  children,
}: {
  question: React.ReactNode;
  note?: React.ReactNode;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0 sm:max-w-md">
        <div className="text-sm leading-relaxed font-medium text-foreground">{question}</div>
        {/* The whole caveat is parenthesised — "(Note: …)" — rather than bolding a
            label, which keeps it reading as an aside to the question. */}
        {note ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            (<span className="font-medium">Note:</span> {note})
          </p>
        ) : null}
        {help ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{help}</p> : null}
      </div>
      <div className="shrink-0 sm:pt-0.5 sm:text-right">{children}</div>
    </div>
  );
}

/**
 * Inline dropdown answer: reads as blue text + chevron, not a boxed input. Built on the Select primitive but styled as an inline link, so it keeps
 * the settings-row look without shipping an unstyled OS widget. Posts with the
 * surrounding server-action form via SelectField's hidden input.
 */
export function SelectAnswer({
  name,
  defaultValue,
  options,
  className,
}: {
  name: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <SelectField
        name={name}
        defaultValue={defaultValue}
        ariaLabel={name}
        options={options}
        className={cn(
          "h-auto w-auto justify-end gap-1 border-transparent bg-transparent py-1 pr-1 pl-2 shadow-none",
          "text-sm font-medium text-primary hover:border-border hover:bg-muted/40",
          "[&>svg]:text-primary",
        )}
      />
    </span>
  );
}

/** Switch answer, on the Switch primitive. Posts via SwitchField's
 *  hidden input, so `formData.get(name) === 'on'` is unchanged. */
export function ToggleAnswer({
  name,
  defaultChecked,
  label,
}: {
  name: string;
  defaultChecked?: boolean;
  /** Accessible name — the question text is not programmatically tied to the input. */
  label: string;
}) {
  return <SwitchField name={name} defaultChecked={defaultChecked} ariaLabel={label} />;
}

/** Contextual tip card in the right rail. */
export function SettingsTip({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <Lightbulb className="mb-2 size-4 text-warning" aria-hidden />
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
      {action ? <div className="mt-2 text-xs">{action}</div> : null}
    </div>
  );
}
