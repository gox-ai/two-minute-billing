import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { PageHeader, type Crumb } from "@/components/page-header";
import { SubmitButton } from "@/components/form/submit-button";
import {
  AttentionCard,
  RecordCard,
  Row,
  type AttentionItem,
} from "@/components/patterns/record-page";
import { SettingError } from "./setting-error";

/**
 * The settings-page layout: header → at most one "Needs attention" band → cards on
 * the left, a "Your setup" summary on the right in a wide column → one sticky Save bar.
 *
 * Shape of a one-form page:
 *
 *   <SettingsPage title crumbs description attention={items}>
 *     <ActionForm action={…}>
 *       <SettingsColumns summary={<SettingsSummary items={…} />} save={{ note: "…" }}>
 *         <SettingsCard title="…">
 *           <SettingRow label="…" help="…" placement="end" control={<SelectAnswer …/>} />
 *         </SettingsCard>
 *       </SettingsColumns>
 *     </ActionForm>
 *   </SettingsPage>
 *
 * Server-safe: no hooks here, so a server page can render every part directly.
 */

export type { AttentionItem } from "@/components/patterns/record-page";

export interface SettingsPageProps {
  title: React.ReactNode;
  /** One line under the title. */
  description?: React.ReactNode;
  crumbs: Crumb[];
  /** The one "Needs attention" band; renders nothing when empty. */
  attention?: AttentionItem[];
  /** Header-right actions (rare on settings pages). */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsPage({
  title,
  description,
  crumbs,
  attention,
  actions,
  children,
}: SettingsPageProps) {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={title}
        description={description ? <div className="max-w-3xl">{description}</div> : undefined}
        breadcrumbs={crumbs}
        actions={actions}
        className="mb-1"
      />
      {attention?.length ? <AttentionCard items={attention} /> : null}
      {children}
    </div>
  );
}

export interface SettingsSaveProps {
  /** Button label. Default "Save". */
  label?: string;
  /** One line at the bar's left, e.g. when the change takes effect. */
  note?: React.ReactNode;
}

/**
 * The page's one Save: a sticky bar at the foot of the page, at every width (the create
 * forms' bar). It must be the LAST thing inside the page's one form, because it bleeds
 * into the shell's padding. `children` go before Save (a dirty count, Discard).
 */
export function SettingsSaveBar({
  label = "Save",
  note,
  disabled,
  children,
}: SettingsSaveProps & { disabled?: boolean; children?: React.ReactNode }) {
  return (
    <div
      data-action-bar
      // The shell's padding, whatever Billy adds to it: flush with main's foot (layout.tsx).
      className="sticky bottom-0 z-10 -mx-5 -mb-(--main-pb) flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-card px-5 py-3 md:-mx-10 md:px-10"
    >
      {note ? <p className="m-0 min-w-0 flex-1 text-xs text-muted-foreground">{note}</p> : null}
      <div className="ml-auto flex items-center gap-2">
        {children}
        <SubmitButton disabled={disabled}>{label}</SubmitButton>
      </div>
    </div>
  );
}

/**
 * 8/4 in a wide column: cards on the left, `summary` sticky on the right. Narrower it is one
 * column with the summary after the cards. With `save`, the page's Save renders in the
 * sticky bottom bar — so this must be the LAST thing in the page's form.
 */
export function SettingsColumns({
  summary,
  save,
  children,
}: {
  summary?: React.ReactNode;
  save?: SettingsSaveProps;
  children: React.ReactNode;
}) {
  return (
    <>
      <Row span={summary ? "8/4" : "12"}>
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
        {summary ? (
          <div className="min-w-0">
            <aside
              aria-label="Your setup"
              className="anim-rise overflow-hidden rounded-xl border bg-card @min-[59.5rem]/main:sticky @min-[59.5rem]/main:top-[calc(var(--compact-h,0px)+1rem)]"
            >
              {summary}
            </aside>
          </div>
        ) : null}
      </Row>
      {save ? <SettingsSaveBar {...save} /> : null}
    </>
  );
}

export interface SummaryItem {
  label: React.ReactNode;
  /** A plain sentence of what is SAVED — never the unsaved form state. */
  value: React.ReactNode;
}

/** The right-column summary card body: a title strip and label/value lines. */
export function SettingsSummary({
  title = "Your setup",
  items,
}: {
  title?: string;
  items: Array<SummaryItem | null | false | undefined>;
}) {
  return (
    <>
      <div className="border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <SummaryList items={items} />
    </>
  );
}

/** Label-over-value lines; falsy entries are skipped so callers can inline conditions. */
export function SummaryList({ items }: { items: Array<SummaryItem | null | false | undefined> }) {
  const shown = items.filter(Boolean) as SummaryItem[];
  return (
    <dl className="divide-y px-5 py-1">
      {shown.map((it, i) => (
        <div key={i} className="flex flex-col gap-0.5 py-2.5">
          <dt className="text-xs text-muted-foreground">{it.label}</dt>
          <dd className="m-0 text-sm font-medium wrap-anywhere">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A card with a header strip (title + one-line meta + optional actions on the
 * right). Children are rows: `SettingRow`s divide themselves. `padded` gives a plain
 * body instead, for free-form content.
 */
export function SettingsCard({
  id,
  title,
  meta,
  actions,
  padded = false,
  children,
  footer,
}: {
  id?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  /** Header-right: a switch, a link, an "Add" button. */
  actions?: React.ReactNode;
  padded?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <RecordCard id={id} title={title} meta={meta} actions={actions} flush footer={footer}>
      <div className={cn(padded ? "px-5 py-4" : "divide-y")}>{children}</div>
    </RecordCard>
  );
}

export interface SettingRowProps {
  label: React.ReactNode;
  /** Links the label to the control's id (a primitive's trigger id = its `name`). */
  htmlFor?: string;
  /** One plain line. */
  help?: React.ReactNode;
  /** The control. `end` = right of the text (switches); `below` = under the label. */
  control?: React.ReactNode;
  placement?: "end" | "below";
  /** What the CURRENT value does. Renders in a quiet well under the row. */
  consequence?: React.ReactNode;
  /** Long explanation, folded behind "More". */
  more?: React.ReactNode;
  /** Shows the ActionForm field error for this name under the control. */
  errorFor?: string;
  /** Extra content under everything (a sub-table, a list). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * One setting. `end` (the settings-row style): label and help on the left, the answer at
 * the card's right edge — a `SelectAnswer`, a `ToggleAnswer`, or a short boxed input on
 * the 80/120/288 scale. `below` is only for a block that needs the full width (an
 * address, a list, a textarea).
 */
export function SettingRow({
  label,
  htmlFor,
  help,
  control,
  placement = "below",
  consequence,
  more,
  errorFor,
  children,
  className,
}: SettingRowProps) {
  const title = htmlFor ? (
    <label htmlFor={htmlFor} className="text-sm font-medium">
      {label}
    </label>
  ) : (
    <p className="m-0 text-sm font-medium">{label}</p>
  );
  const helpLine = help ? (
    <p className="m-0 text-xs leading-normal text-muted-foreground">{help}</p>
  ) : null;

  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4", className)}>
      {placement === "end" ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {title}
            {helpLine}
          </div>
          {control ? (
            <div className="flex max-w-full min-w-0 shrink-0 sm:justify-end">{control}</div>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5">
          {title}
          {helpLine}
          {control ? <div className="min-w-0 pt-1">{control}</div> : null}
        </div>
      )}
      {errorFor ? <SettingError name={errorFor} /> : null}
      {consequence ? <Consequence>{consequence}</Consequence> : null}
      {more ? <More>{more}</More> : null}
      {children}
    </div>
  );
}

/** "What this value does" — the neutral `Alert`. */
export function Consequence({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Alert tone="neutral" className={className}>
      {children}
    </Alert>
  );
}

/** A native disclosure: the body stays mounted, so fields inside it still post. */
export function More({
  label = "More",
  children,
}: {
  label?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className="group text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center py-1 text-primary hover:underline [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">{label}</span>
        <span className="hidden group-open:inline">Less</span>
      </summary>
      <div className="pt-1 leading-normal text-muted-foreground">{children}</div>
    </details>
  );
}

/** A small sentence-case label for a control that sits under a row title. */
export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
      {children}
    </label>
  );
}

/**
 * A hub row: title, one-line description, the current value right-aligned, and a
 * chevron (an arrow when it leaves the section). The whole row links. `value` must be
 * read off the real field — omit it rather than show a placeholder.
 */
export function SettingsLinkRow({
  title,
  description,
  value,
  href,
  external,
  badge,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  value?: React.ReactNode;
  href: string;
  external?: boolean;
  /** A chip beside the title, e.g. TEST. */
  badge?: React.ReactNode;
}) {
  const Icon = external ? ArrowUpRight : ChevronRight;
  // The current value on a muted ground with no border: a reading, not a button.
  const pill = (cls: string) =>
    value ? (
      <span
        className={cn(
          "rounded-md bg-muted px-2 py-0.5 text-sm wrap-anywhere text-foreground/85",
          cls,
        )}
      >
        {value}
      </span>
    ) : null;
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-medium text-foreground">{title}</span>
          {badge}
        </span>
        {description ? (
          <span className="text-sm leading-normal text-muted-foreground">{description}</span>
        ) : null}
        {pill("mt-1 self-start sm:hidden")}
      </span>
      {pill("hidden max-w-[16rem] shrink-0 text-right sm:block")}
      <Icon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </Link>
  );
}
