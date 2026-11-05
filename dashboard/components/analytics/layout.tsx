import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/analytics/info-tip";
import type { CardInfo } from "@/components/analytics/card-info";

/**
 * The analytics layout system.
 *
 * Three earlier attempts at these screens failed as "crowded", then "sparse", then "bits and
 * pieces". The cause was never the content: it was that every block invented its own width,
 * padding and type step, so near-repetitions (22 next to 24 next to 26) read as noise. This
 * file is the fix — one grid, one card anatomy, one number ladder, five component shapes.
 * Nothing on an analytics screen may set its own width or padding; it composes these instead.
 *
 * - Grid: 12 columns, 24px gutter. A block spans 12, 6+6, 8+4, 9+3, 4+4+4 or 3+3+3+3.
 * - Spacing: 4 / 8 / 12 / 16 / 24 only (Tailwind 1 / 2 / 3 / 4 / 6).
 * - Type: 12 / 14 / 15 / 17 / 26 / 32 (xs / sm / base / lg / 2xl / 3xl). `text-xl` (20px) is
 *   deliberately unused here — it did 26's job and made the scale read as seven steps.
 * - Card: a header row (title, link) over a hairline, then a 20px body and an optional footer
 *   of 16px + hairline + 12px.
 *
 * The artboards draw two rule weights (#e2e9f2 for a card edge and a column head, #eef2f7 for
 * a row rule). Our token set has ONE border colour, so both render as `border-border`; a
 * second hairline token would be a new token, not a use of the existing set.
 */

/** 12 columns, 24px gutter. Every analytics block sits in one of these. */
export function Grid({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid grid-cols-12 gap-6", className)}>{children}</div>;
}

/** The only spans a block may take. A width outside this list is the bug this file exists for. */
export type Span = 3 | 4 | 6 | 8 | 9 | 12;

const SPAN: Record<Span, string> = {
  // A quarter needs ~250px for a figure, its delta and a stat row: 1400px (87.5rem — rem, so it
  // sorts after `lg:`; a px breakpoint is emitted first and loses) leaves that beside
  // the rail. Halves until then; md halves were ~250px and cramped the same way.
  3: "col-span-12 lg:col-span-6 min-[87.5rem]:col-span-3",
  4: "col-span-12 lg:col-span-6 xl:col-span-4",
  6: "col-span-12 xl:col-span-6",
  8: "col-span-12 xl:col-span-8",
  9: "col-span-12 xl:col-span-9",
  12: "col-span-12",
};

export function spanClass(span: Span): string {
  return SPAN[span];
}

/** The page stack: blocks at 24px, nothing else between them. */
export function Stack({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-col gap-6", className)}>{children}</div>;
}

/**
 * The one card anatomy, used by every block on every analytics screen.
 *
 * A titled card puts its title in a header row over a hairline, the link opposite; the body
 * is padded 20px. `flat` keeps the title inline with no hairline, for a card whose body is one
 * chart or one figure. The footer is the only place a caveat goes.
 */
export function Block({
  span,
  title,
  chip,
  action,
  footer,
  className,
  fill,
  info,
  flat = false,
  children,
}: {
  /** What the card counts, behind an (i) beside the title. */
  info?: CardInfo;
  /** The body takes the card's spare height, so a chart inside can grow into it. */
  fill?: boolean;
  span: Span;
  /** Omitted for a card whose figure IS its title (the 3-span figure cards). */
  title?: React.ReactNode;
  chip?: React.ReactNode;
  /** A link opposite the title — the way out of this block, never a second title. */
  action?: React.ReactNode;
  /** The honesty line: coverage, basis, what was excluded. */
  footer?: React.ReactNode;
  className?: string;
  /** Title inline with the body, no header row. */
  flat?: boolean;
  children?: React.ReactNode;
}) {
  const head = title ? (
    // Wraps rather than squeezing: a narrow card drops its link to the next line instead of
    // breaking the title or the link mid-phrase.
    <div
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", !flat && "border-b px-5 py-3.5")}
    >
      <span className="text-base font-medium whitespace-nowrap">{title}</span>
      {info ? (
        <InfoTip label={typeof title === "string" ? title : "This card"} info={info} />
      ) : null}
      {chip ? <Chip>{chip}</Chip> : null}
      {action ? <div className="ml-auto whitespace-nowrap">{action}</div> : null}
    </div>
  ) : null;
  return (
    <Card
      className={cn(
        "anim-rise @container gap-0 overflow-hidden py-0",
        flat && "p-5",
        spanClass(span),
        className,
      )}
    >
      {head}
      <div
        className={cn("flex min-w-0 flex-1 flex-col", !flat && (title ? "px-5 pt-4 pb-5" : "p-5"))}
      >
        {children ? (
          <div className={cn("min-w-0", flat && title && "mt-3", fill && "flex flex-1 flex-col")}>
            {children}
          </div>
        ) : null}
        {footer ? (
          <>
            <div className="flex-1" />
            <div className="mt-4 border-t pt-3 text-xs text-muted-foreground tabular-nums">
              {footer}
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** A qualifier on a title: what window, what basis, how many. 12px, bordered, radius 8. */
export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

/** The link out of a block. */
export function BlockLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-sm font-medium text-primary hover:underline">
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ figures */

/**
 * The page's single 32px figure. Exactly one per screen — a second one makes neither of them
 * the answer to the question the page asks.
 */
export function Hero({
  value,
  title,
  support,
  note,
}: {
  value: string;
  /** The full-precision value, for the hover. */
  title?: string;
  support?: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col justify-center gap-1">
      <span className="text-3xl font-semibold tabular-nums" title={title}>
        {value}
      </span>
      {support ? <span className="text-sm tabular-nums">{support}</span> : null}
      {note ? <span className="text-xs text-muted-foreground tabular-nums">{note}</span> : null}
    </div>
  );
}

/** A 26px figure with its label above and an optional qualifier below. */
export function Figure({
  label,
  value,
  note,
  title,
  tone,
}: {
  label: React.ReactNode;
  value: string;
  note?: React.ReactNode;
  title?: string;
  /** `attention` colours the LABEL, never the figure — the number is the number. */
  tone?: "attention";
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={cn("text-sm", tone === "attention" ? "text-warning" : "text-muted-foreground")}
      >
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums" title={title}>
        {value}
      </span>
      {note ? <span className="text-xs text-muted-foreground tabular-nums">{note}</span> : null}
    </div>
  );
}

/** The KPI label: small, tracked, uppercase — the figure under it is what gets read. */
export const KPI_LABEL = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

/**
 * The 3-span figure card: label, 26px figure, qualifier. Four of these make a row.
 * Its own component because the label sits ABOVE the figure here, not beside it.
 */
export function FigureBlock({
  span = 3,
  title,
  value,
  note,
  full,
  footer,
  progress,
  info,
}: {
  span?: Span;
  title: string;
  info?: CardInfo;
  value: string;
  note?: React.ReactNode;
  /** The full-precision value, for the hover. */
  full?: string;
  footer?: React.ReactNode;
  /** A 0–1 fraction drawn as a bar under the figure — only where the figure IS a fraction. */
  progress?: number | null;
}) {
  return (
    <Block span={span} footer={footer}>
      <div className="flex flex-col">
        <span className="flex items-center gap-1">
          <span className={KPI_LABEL}>{title}</span>
          {info ? <InfoTip label={title} info={info} /> : null}
        </span>
        <span className="mt-3 text-2xl font-semibold tabular-nums" title={full}>
          {value}
        </span>
        {progress != null && Number.isFinite(progress) ? (
          <span className="mt-3 block h-1.5 rounded-full bg-muted" aria-hidden>
            <span
              className="anim-grow block h-full rounded-full bg-chart-1"
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </span>
        ) : null}
        {note ? (
          <span className="mt-2 text-sm text-muted-foreground tabular-nums">{note}</span>
        ) : null}
      </div>
    </Block>
  );
}

/** A row of 26px figures inside one card — the "five things at a glance" shape. */
export function FigureRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-4 [&>*]:min-w-24 [&>*]:flex-1">{children}</div>
  );
}

/* ------------------------------------------------------------------- tables */

/**
 * ONE number ladder, shared by every table and every reading on every screen. A column that
 * invents its own width is what made two tables side by side look like two designs.
 */
export const LADDER = {
  /** A count. */
  count: "w-18 shrink-0 text-right tabular-nums",
  /** An amount of money. */
  amount: "w-30 shrink-0 text-right tabular-nums",
  /** Anything else read beside them — an age, a rate, a share. */
  secondary: "w-24 shrink-0 text-right tabular-nums",
} as const;

/** 32px head, 12px tracked labels, one hairline under it. */
export function Head({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-row=""
      className="flex h-8 min-w-max items-center gap-4 border-b text-xs font-semibold tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </div>
  );
}

/** 44px row. The last row in a table drops its rule. */
export function Row({
  last,
  className,
  children,
}: {
  last?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-row=""
      className={cn(
        "flex h-11 min-w-max items-center gap-4 text-sm",
        !last && "border-b",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The dot that says how hot a queue is. Terminal and healthy states stay neutral. */
export function Dot({ tone }: { tone: "attention" | "warning" | "neutral" }) {
  return (
    <span className="flex w-3.5 shrink-0">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          tone === "attention" && "bg-destructive",
          tone === "warning" && "bg-warning",
          tone === "neutral" && "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}

/* --------------------------------------------------------------------- bars */

/**
 * The bar row: a 160px label, an 8px track that measures a real fraction, then the number
 * ladder. The track is the ONLY bar shape on these screens.
 */
export function BarRow({
  label,
  href,
  fraction,
  value,
  count,
  tone = "neutral",
  last,
}: {
  label: React.ReactNode;
  href?: string | null;
  /** 0..1 of the widest row — a real proportion, never a rank. */
  fraction: number;
  value: string;
  count?: string;
  tone?: "neutral" | "strong" | "warning" | "attention";
  last?: boolean;
}) {
  const fill =
    tone === "attention"
      ? "bg-destructive"
      : tone === "warning"
        ? "bg-warning"
        : tone === "strong"
          ? "bg-foreground"
          : "bg-chart-1";
  return (
    <div className={cn("flex items-center gap-4 text-sm", !last && "mb-4")}>
      {href ? (
        <Link href={href} className="w-24 shrink-0 truncate text-sm hover:underline lg:w-40">
          {label}
        </Link>
      ) : (
        <span className="w-24 shrink-0 truncate text-sm text-muted-foreground lg:w-40">
          {label}
        </span>
      )}
      <div className="h-2 min-w-0 flex-1 rounded-md bg-muted">
        <div
          className={cn("anim-grow h-2 rounded-md", fill)}
          style={{ width: `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%` }}
        />
      </div>
      <span className={LADDER.amount}>{value}</span>
      {count != null ? (
        // The count is the row's supporting figure: it steps aside on a phone for the bar.
        <span className={cn(LADDER.count, "hidden text-muted-foreground lg:inline")}>{count}</span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- notes */

/**
 * The page's last line: when it was computed, what the periods cover, the currency basis, and
 * anything the conversion had to drop. Quiet by design — it is the honesty, not the headline.
 */
export function PageNote({
  children,
  warning,
}: {
  children: React.ReactNode;
  /** Named separately so an excluded currency reads as a thing to fix, not as fine print. */
  warning?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <span>{children}</span>
      {warning ? <span className="text-warning">{warning}</span> : null}
    </div>
  );
}
