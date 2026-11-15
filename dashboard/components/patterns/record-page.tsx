import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { LARGE_TITLE_COLLAPSE } from "@/lib/motion";
import { RollingNumber } from "@/components/ui/rolling-number";
import { CompactTitle } from "@/components/large-title";
import type { Crumb } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { NoWrapDates } from "@/components/patterns/nowrap-dates";
import { figureTileMin } from "@/lib/figure-fit";

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
            <span aria-hidden className="text-muted-foreground/80">
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
  /** Short facts, spaced by a gap (stacked below 40rem); falsy entries are skipped. */
  facts?: React.ReactNode[];
  actions?: React.ReactNode;
}) {
  const shown = (facts ?? []).filter(Boolean);
  return (
    // Wraps by content, not the window: the actions drop below the title when the title would
    // get less than 22rem (a docked panel narrows the page without narrowing the window).
    <header className="anim-fade flex flex-wrap items-center gap-4 rounded-xl border bg-card px-5 py-4.5">
      <div className="flex min-w-0 flex-[1_1_22rem] items-center gap-4 max-sm:items-start max-sm:gap-3">
        {avatar ? (
          <div
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground max-sm:size-10 max-sm:text-base"
          >
            {avatar}
          </div>
        ) : null}
        {/* On a phone the title takes its own line and the chips and facts share ONE wrapping
            row under it (both wrappers are `contents` there); an id shortens in the middle to
            share a line instead of taking one of its own. */}
        <div className="flex min-w-0 flex-col gap-1 max-sm:flex-row max-sm:flex-wrap max-sm:items-center max-sm:gap-x-2 max-sm:gap-y-1.5 max-sm:[&_[data-id-text]>:first-child]:max-w-20">
          <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 max-sm:contents">
            <div className="relative min-w-0 max-sm:mb-0.5 max-sm:basis-full">
              {/* A list row's name lands here on a push (lib/shared-title.ts); the compact copy never does. */}
              <h1
                data-record-title
                className="text-2xl font-semibold tracking-[-0.02em] wrap-anywhere"
              >
                {title}
              </h1>
              {/* Title only: record actions open dialogs, and a second copy would mount twice. */}
              {LARGE_TITLE_COLLAPSE ? <CompactTitle title={title} /> : null}
            </div>
            {chips}
          </div>
          {shown.length ? (
            // Gaps, not dots: a wrapped line never starts with a separator.
            <div className="flex flex-col gap-y-1 text-sm text-muted-foreground max-sm:contents sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
              {shown.map((f, i) => (
                <span key={i} className="max-w-full min-w-0 wrap-break-word">
                  <NoWrapDates>{f}</NoWrapDates>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? (
        // A phone gives the actions a full row; a button grows, More stays beside it.
        <div className="flex max-w-full flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>[data-slot=button]:not([aria-haspopup=menu])]:flex-[1_1_auto] max-sm:[&>form]:flex-[1_1_auto] max-sm:[&>form_[data-slot=button]]:w-full">
          {actions}
        </div>
      ) : null}
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
  // One `Alert` per problem, each with its own action; the history under them sits on a card.
  return (
    <section aria-label="Needs attention" className="anim-rise @container flex flex-col gap-3">
      <div
        className={cn(
          "grid grid-cols-1 gap-3",
          columns && items.length > 1 && "@[43.5rem]:grid-cols-2",
        )}
      >
        {items.map((it) => (
          <Alert
            key={it.key}
            tone={it.tone === "attention" ? "error" : "warning"}
            title={<span className="text-base tabular-nums">{it.title}</span>}
            action={
              it.actions ? (
                <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
                  {it.actions}
                </div>
              ) : null
            }
          >
            {it.detail ? <span className="tabular-nums">{it.detail}</span> : null}
          </Alert>
        ))}
      </div>
      {children ? (
        <div className="overflow-hidden rounded-xl border bg-card">{children}</div>
      ) : null}
    </section>
  );
}

/** The value a figure card shows when it has none. */
export const EMPTY_FIGURE = "—";

/**
 * An empty figure at a calm size. It sits inside the figure's own line box, so the note
 * under it stays level with its neighbours' notes.
 */
export function EmptyFigure() {
  return <span className="text-lg font-normal text-muted-foreground">{EMPTY_FIGURE}</span>;
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
  // Columns follow the page's own width (the window's md and xl, less the rail and padding:
  // 440px and 952px), so a docked panel gives the same layout as a narrower window.
  // On a phone, two tiles share a row only where every figure fits whole (lib/figure-fit.ts).
  const min = figureTileMin(
    React.Children.toArray(children).map((c) =>
      React.isValidElement<{ value?: unknown }>(c) && c.type === FigureTile ? c.props.value : null,
    ),
  );
  return (
    <div className="@container">
      <div
        style={min ? ({ "--fig-min": min } as React.CSSProperties) : undefined}
        className={cn(
          "grid grid-cols-1 gap-6 max-sm:gap-3 @[27.5rem]:grid-cols-2",
          min &&
            "max-sm:grid-cols-[repeat(auto-fit,minmax(max(var(--fig-min),calc(50%-0.375rem)),1fr))]",
          cols === 4 && "@[59.5rem]:grid-cols-4",
        )}
      >
        {children}
      </div>
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
  /** The row's one ink card with a brand glow. Pass false while the figure is zero. */
  featured?: boolean;
}) {
  const empty = value === EMPTY_FIGURE;
  // Emphasis only frames a figure: an empty one stays a plain card.
  const feature = featured && !empty;
  // Header row over a hairline, then the figure and its note — the business Home's KPI card.
  const card = (
    <Card
      className={cn(
        "anim-rise h-full min-w-0 gap-0 overflow-hidden py-0",
        feature && "surface-feature",
        href && "hoverable group-hover:border-primary/40",
      )}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
        {Icon ? (
          <Icon
            aria-hidden
            className={cn("size-4 shrink-0", feature ? "text-primary" : "text-foreground/70")}
          />
        ) : null}
        {/* Two tiles share a phone's row, so a long label wraps there instead of clipping. */}
        <span className="min-w-0 sm:truncate">{label}</span>
      </div>
      <div className="flex flex-1 flex-col px-4 pt-3.5 pb-4">
        <span
          className={cn(
            "text-2xl font-semibold tracking-[-0.02em] wrap-anywhere tabular-nums",
            tone === "loss" && "text-destructive",
          )}
          title={title}
        >
          {empty ? <EmptyFigure /> : <RollingNumber value={value} />}
        </span>
        {note ? (
          <span className="mt-1 text-sm text-muted-foreground">
            <NoWrapDates>{note}</NoWrapDates>
          </span>
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
  // By the page's own width, as FigureTiles: 952px (the window's xl) and 696px (lg).
  return (
    <div className="@container">
      <div
        className={cn(
          "grid grid-cols-1 gap-4",
          span === "8/4" && "@[59.5rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
          span === "6/6" && "@[43.5rem]:grid-cols-2",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Several cards in one cell of a Row; the last one grows to fill the row. */
export function Stack({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4 *:last:flex-1">{children}</div>;
}

/**
 * A card's header row (RecordCard, SectionCard `card`, FoldedCard). On a phone the title
 * keeps its line: the item before the actions grows instead of the actions taking
 * `ml-auto`, so actions that do not fit wrap to a row of their own at the start, under it.
 */
const CARD_HEAD = "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-3.5 max-sm:gap-y-2";
export const CARD_HEAD_GROW = "max-sm:grow";
export const CARD_HEAD_ACTIONS = "flex flex-wrap items-center gap-3 text-sm sm:ml-auto";

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
      <div className={CARD_HEAD}>
        <h2 className={cn("text-base font-medium", !meta && CARD_HEAD_GROW)}>{title}</h2>
        {meta ? (
          <span className={cn("text-xs text-muted-foreground tabular-nums", CARD_HEAD_GROW)}>
            {meta}
          </span>
        ) : null}
        {actions ? <div className={CARD_HEAD_ACTIONS}>{actions}</div> : null}
      </div>
      <div className={cn("flex-1", !flush && "px-5 py-4")}>{children}</div>
      {footer ? <div className="border-t px-5 py-2.5 text-sm">{footer}</div> : null}
    </section>
  );
}

/**
 * A label/value row on a phone (`Facts`, other definition rows): the value stays beside its
 * label while it fits there whole, else it takes the full width under the label. The row
 * box is `contents` from 640px up, so a desktop grid of `dt`/`dd` is unchanged.
 */
export const PHONE_FACT =
  "max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-4 max-sm:gap-y-0.5 sm:contents";
/** The label column: 40%, as on a desktop, so values beside their labels line up. */
export const PHONE_FACT_LABEL = "max-sm:shrink-0 max-sm:basis-[40%]";
/** Its value: no wider than it needs on the label's line; alone on its own line otherwise. */
export const PHONE_FACT_VALUE = "max-sm:flex-[1_1_auto] max-sm:min-w-0";

/** Label/value pairs with the value kept next to its label. */
export function Facts({
  rows,
}: {
  rows: Array<{ label: React.ReactNode; value: React.ReactNode } | null | false | undefined>;
}) {
  return (
    <dl className="grid grid-cols-[40%_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm max-sm:flex max-sm:flex-col">
      {rows.filter(Boolean).map((r, i) => {
        const row = r as { label: React.ReactNode; value: React.ReactNode };
        return (
          <div key={i} className={PHONE_FACT}>
            <dt className={cn("text-muted-foreground", PHONE_FACT_LABEL)}>{row.label}</dt>
            <dd className={cn("m-0 min-w-0 wrap-anywhere", PHONE_FACT_VALUE)}>
              <NoWrapDates>{row.value ?? "—"}</NoWrapDates>
            </dd>
          </div>
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
      <div className="flex items-center gap-3 border-b px-5 py-3.5 max-sm:flex-wrap max-sm:gap-y-2">
        <h2 className={cn("text-base font-medium", CARD_HEAD_GROW)}>{title}</h2>
        {actions ? <div className={CARD_HEAD_ACTIONS}>{actions}</div> : null}
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
