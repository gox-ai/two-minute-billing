import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Crumb } from "@/components/page-header";
import { Card } from "@/components/ui/card";

/**
 * The record-page layout (customer and subscription detail): a header card, a
 * "needs attention" card that renders only when something does, four figure
 * tiles, then zones of cards laid out ROW by row on one grid — each row stretches
 * to its tallest card, so a short column never leaves a gap under it.
 */

export function RecordCrumbs({ items, right }: { items: Crumb[]; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Crumbs items={items} />
      {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
    </div>
  );
}

function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      {items.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden className="text-muted-foreground/60">
              /
            </span>
          ) : null}
          {c.href ? (
            <Link href={c.href} className="text-muted-foreground hover:text-foreground">
              {c.label}
            </Link>
          ) : (
            <span className="font-medium">{c.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function RecordHeader({
  avatar,
  title,
  chips,
  facts,
  actions,
}: {
  avatar?: string;
  title: React.ReactNode;
  chips?: React.ReactNode;
  /** Short facts joined with a middle dot; falsy entries are skipped. */
  facts?: React.ReactNode[];
  actions?: React.ReactNode;
}) {
  const shown = (facts ?? []).filter(Boolean);
  return (
    <header className="anim-fade flex flex-col gap-4 rounded-xl border bg-card px-5 py-4.5 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {avatar ? (
          <div
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground"
          >
            {avatar}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-medium tracking-[-0.02em] wrap-anywhere">{title}</h1>
            {chips}
          </div>
          {shown.length ? (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
              {shown.map((f, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <span aria-hidden>·</span> : null}
                  <span className="min-w-0 wrap-anywhere">{f}</span>
                </React.Fragment>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export interface AttentionItem {
  key: string;
  /** `attention` = money at risk now; `warning` = soon, or already scheduled. */
  tone: "attention" | "warning";
  title: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
}

/**
 * What needs a person, one cell per problem with its own action. Tinted and edged
 * so it never reads as a content card. Renders nothing when nothing is wrong.
 */
export function AttentionCard({
  items,
  columns = true,
  children,
}: {
  items: AttentionItem[];
  /** Side by side (customer) or stacked rows (subscription, where a track follows). */
  columns?: boolean;
  children?: React.ReactNode;
}) {
  if (items.length === 0) return null;
  const urgent = items.some((i) => i.tone === "attention");
  // The tint marks the rows that need a person; the history under them sits on the card.
  return (
    <section
      aria-label="Needs attention"
      className={cn(
        "anim-rise overflow-hidden rounded-xl border bg-card",
        urgent ? "border-destructive/20" : "border-warning/25",
      )}
    >
      <div
        className={cn(
          "grid grid-cols-1",
          urgent
            ? "divide-destructive/15 bg-destructive-soft/40"
            : "divide-warning/20 bg-warning-soft/40",
          columns && items.length > 1
            ? "divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0"
            : "divide-y",
        )}
      >
        {items.map((it) => (
          <div
            key={it.key}
            className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4"
          >
            {/* A real basis, so on a narrow screen the actions drop below the text
                instead of squeezing it to a word per line. */}
            <div className="flex min-w-0 grow basis-60 items-start gap-3">
              <span
                aria-hidden
                className={cn(
                  "mt-2 size-2 shrink-0 rounded-full",
                  it.tone === "attention" ? "bg-destructive" : "bg-warning",
                )}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-base font-semibold wrap-anywhere tabular-nums">
                  {it.title}
                </span>
                {it.detail ? (
                  <span className="text-sm text-muted-foreground tabular-nums">{it.detail}</span>
                ) : null}
              </div>
            </div>
            {it.actions ? (
              <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
                {it.actions}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {children ? (
        <div className={cn("border-t", urgent ? "border-destructive/15" : "border-warning/20")}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** The figure row: four header-row cards, the business Home's KPI shape. */
export function FigureTiles({
  children,
  cols = 4,
}: {
  children: React.ReactNode;
  /** Match the tile count so no column sits empty. */
  cols?: 2 | 4;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-6 md:grid-cols-2", cols === 4 && "xl:grid-cols-4")}>
      {children}
    </div>
  );
}

export function FigureTile({
  label,
  value,
  note,
  tone,
  href,
  title,
  icon: Icon,
  featured = false,
}: {
  label: string;
  value: string;
  note?: React.ReactNode;
  tone?: "loss";
  href?: string;
  /** Full figure on hover, when `value` is shortened. */
  title?: string;
  /** Leads the header row. */
  icon?: React.ComponentType<{ className?: string }>;
  /** The row's one ink card with a brand glow. */
  featured?: boolean;
}) {
  // Header row over a hairline, then the figure and its note — the business Home's KPI card.
  const card = (
    <Card
      className={cn(
        "anim-rise h-full min-w-0 gap-0 overflow-hidden py-0",
        featured && "surface-feature",
        href && "hoverable group-hover:border-primary/40",
      )}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
        {Icon ? (
          <Icon
            aria-hidden
            className={cn("size-4 shrink-0", featured ? "text-primary" : "text-foreground/70")}
          />
        ) : null}
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className="flex flex-1 flex-col px-4 pt-3.5 pb-4">
        <span
          className={cn(
            "text-2xl font-medium tracking-[-0.02em] wrap-anywhere tabular-nums",
            tone === "loss" && "text-destructive",
          )}
          title={title}
        >
          {value}
        </span>
        {note ? (
          <span className="mt-1 text-sm text-muted-foreground tabular-nums">{note}</span>
        ) : null}
      </div>
    </Card>
  );
  return href ? (
    <Link href={href} className="group min-w-0">
      {card}
    </Link>
  ) : (
    card
  );
}

/** A labelled group of rows, in task order down the page. */
export function Zone({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="mt-4 flex flex-col gap-3">
      {title ? <h2 className="text-lg font-medium tracking-[-0.01em]">{title}</h2> : null}
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

/**
 * One row of the grid. `8/4` = primary + supporting, `6/6` = equal peers, `12` = a
 * wide table. Cells stretch to the tallest, so spare height stays inside a card.
 */
export function Row({ span, children }: { span: "8/4" | "6/6" | "12"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4",
        span === "8/4" && "xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
        span === "6/6" && "lg:grid-cols-2",
      )}
    >
      {children}
    </div>
  );
}

/** Several cards in one cell of a Row; the last one grows to fill the row. */
export function Stack({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4 *:last:flex-1">{children}</div>;
}

export function RecordCard({
  id,
  title,
  meta,
  actions,
  flush,
  children,
  footer,
}: {
  id?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** No body padding — for a table that runs edge to edge. */
  flush?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="anim-rise flex min-w-0 scroll-mt-24 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-3.5">
        <h2 className="text-base font-medium">{title}</h2>
        {meta ? <span className="text-xs text-muted-foreground tabular-nums">{meta}</span> : null}
        {actions ? (
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">{actions}</div>
        ) : null}
      </div>
      <div className={cn("flex-1", !flush && "px-5 py-4")}>{children}</div>
      {footer ? <div className="border-t px-5 py-2.5 text-sm">{footer}</div> : null}
    </section>
  );
}

/** Label/value pairs with the value kept next to its label. */
export function Facts({
  rows,
}: {
  rows: Array<{ label: React.ReactNode; value: React.ReactNode } | null | false | undefined>;
}) {
  return (
    <dl className="grid grid-cols-[40%_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {rows.filter(Boolean).map((r, i) => {
        const row = r as { label: React.ReactNode; value: React.ReactNode };
        return (
          <React.Fragment key={i}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="m-0 min-w-0 wrap-anywhere">{row.value ?? "—"}</dd>
          </React.Fragment>
        );
      })}
    </dl>
  );
}

export interface FoldedSection {
  id: string;
  title: string;
  /** One line shown while folded. */
  summary: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Reference sections as one-line rows that open in place. Native `<details>` keeps
 * the body mounted, so the dialogs and inline editors inside it keep working.
 */
export function FoldedCard({
  title,
  actions,
  sections,
}: {
  title: string;
  /** Card-level links (one "Edit" for the whole record). Rows carry no actions of
   *  their own, so every row reads the same; row-specific controls live in its body. */
  actions?: React.ReactNode;
  sections: FoldedSection[];
}) {
  return (
    <section className="anim-rise @container overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <h2 className="text-base font-medium">{title}</h2>
        {actions ? <div className="ml-auto flex items-center gap-3 text-sm">{actions}</div> : null}
      </div>
      <div className="divide-y">
        {sections.map((s) => (
          <details key={s.id} id={s.id} className="group scroll-mt-24">
            {/* On a card under 42rem the summary takes its own line under the title; beside
                a 13rem title column it kept ~40-130px and truncated to a word. */}
            <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-4 gap-y-0.5 px-5 py-3 text-sm hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-primary @2xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_1rem] [&::-webkit-details-marker]:hidden">
              <span className="font-semibold">{s.title}</span>
              <span className="truncate text-muted-foreground group-open:invisible @max-2xl:order-last @max-2xl:col-span-2 @max-2xl:group-open:hidden">
                {s.summary}
              </span>
              <ChevronDown
                aria-hidden
                className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="px-5 pt-1 pb-5 @2xl:pl-[calc(13rem+2.25rem)]">{s.children}</div>
          </details>
        ))}
      </div>
    </section>
  );
}
