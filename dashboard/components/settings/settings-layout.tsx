import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight, Info } from "lucide-react";
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
 * the left, a "Your setup" summary (+ the page's Save) on the right at xl.
 *
 * Shape of a one-form page:
 *
 *   <SettingsPage title crumbs description attention={items}>
 *     <ActionForm action={…}>
 *       <SettingsColumns summary={<SettingsSummary items={…} />} save={{ note: "…" }}>
 *         <SettingsCard title="…">
 *           <SettingRow label="…" help="…" control={…} consequence="…" />
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
  /** One line under the button, e.g. when the change takes effect. */
  note?: React.ReactNode;
}

/**
 * 8/4 at xl: cards on the left, `summary` sticky on the right. Below xl it is one
 * column with the summary after the cards. With `save`, the Save sits at the foot of
 * the summary at xl and in a sticky bottom bar below it — so it must be the LAST
 * thing on the page (the bar bleeds into the shell's padding).
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
  const saveBlock = (where: "aside" | "bar") =>
    save ? (
      <div
        className={cn(
          "flex flex-col gap-2",
          where === "aside" ? "hidden border-t px-5 py-4 xl:flex" : "items-stretch",
        )}
      >
        <SubmitButton className="w-full">{save.label ?? "Save"}</SubmitButton>
        {save.note ? (
          <span className={cn("text-xs text-muted-foreground", where === "bar" && "text-center")}>
            {save.note}
          </span>
        ) : null}
      </div>
    ) : null;

  return (
    <>
      <Row span={summary || save ? "8/4" : "12"}>
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
        {summary || save ? (
          <div className="min-w-0">
            <aside
              aria-label="Your setup"
              className="anim-rise overflow-hidden rounded-xl border bg-card xl:sticky xl:top-4"
            >
              {summary}
              {saveBlock("aside")}
            </aside>
          </div>
        ) : null}
      </Row>
      {save ? (
        <div className="sticky bottom-0 z-10 -mx-5 -mb-8 border-t bg-card px-5 py-3 md:-mx-10 md:-mb-10 md:px-10 xl:hidden">
          {saveBlock("bar")}
        </div>
      ) : null}
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

/** One setting: label, help line, control, consequence, optional "More". */
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
    <label htmlFor={htmlFor} className="text-sm font-semibold">
      {label}
    </label>
  ) : (
    <p className="m-0 text-sm font-semibold">{label}</p>
  );
  const helpLine = help ? (
    <p className="m-0 text-sm leading-normal text-muted-foreground">{help}</p>
  ) : null;

  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4", className)}>
      {placement === "end" ? (
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {title}
            {helpLine}
          </div>
          {control ? <div className="shrink-0 pt-0.5">{control}</div> : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5">
          {title}
          {control ? <div className="min-w-0">{control}</div> : null}
          {helpLine}
        </div>
      )}
      {errorFor ? <SettingError name={errorFor} /> : null}
      {consequence ? <Consequence>{consequence}</Consequence> : null}
      {more ? <More>{more}</More> : null}
      {children}
    </div>
  );
}

/** "What this value does" — a quiet filled well with an info glyph. */
export function Consequence({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2.5 text-sm leading-normal text-foreground/85",
        className,
      )}
    >
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">{children}</div>
    </div>
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

/** A small uppercase field label for a control that sits under a row title. */
export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-xs font-medium tracking-[0.06em] text-muted-foreground uppercase"
    >
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
  // The current value is a soft pill, so it reads as a reading, not as more copy.
  const pill = (cls: string) =>
    value ? (
      <span
        className={cn(
          "rounded-full border bg-muted/50 px-2.5 py-0.5 text-sm wrap-anywhere text-foreground/85",
          cls,
        )}
      >
        {value}
      </span>
    ) : null;
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
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
