import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Settings hub (archetype 6a).
 *
 * Layout is a two-column grid per group: the group name + blurb sit in a narrow
 * left column, the rows in a card on the right. Each row is title + description
 * on the left, a live **value hint** and a chevron on the right.
 *
 * The value hint is the whole point of the archetype — it lets an operator read
 * the current configuration off the index without opening anything. It must be
 * derived from the real field (Rule 0); pass `hint={undefined}` rather than
 * inventing a placeholder when a row has nothing meaningful to summarize.
 */

export function SettingsHub({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-10 pb-10", className)}>{children}</div>;
}

export function SettingsGroup({
  title,
  description,
  meta,
  contentClassName,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  /**
   * A summary of the group's current state, under the description — e.g. "6 of 8 on".
   * Rendered as a sibling of the description rather than inside it, because it carries
   * block content and a <p> may not contain one.
   */
  meta?: React.ReactNode;
  /** For state that applies to the whole card, e.g. dimming a group nothing will send. */
  contentClassName?: string;
  children: React.ReactNode;
}) {
  // `items-start` so the card sizes to its rows. Grid items stretch by default, which made
  // a short card grow to match a long left-hand blurb and render dead space inside its own
  // border.
  return (
    <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-8">
      <div className="lg:pt-1">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
        {meta ? <div className="mt-2 text-xs text-muted-foreground">{meta}</div> : null}
      </div>
      <div
        className={cn(
          "divide-y divide-border overflow-hidden rounded-lg border bg-card",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  hint,
  href,
  badge,
  external,
}: {
  title: string;
  description?: React.ReactNode;
  /** Current value, read off the real field — e.g. "Asia/Kolkata", "Enabled", "3 keys". */
  hint?: React.ReactNode;
  href: string;
  badge?: React.ReactNode;
  /** Row points outside the business settings tree (org-level pages). */
  external?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-4 px-5 py-4 transition-colors hover:bg-muted/40"
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge}
        </span>
        {description ? (
          <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {hint ? (
        <span className="hidden max-w-[14rem] shrink-0 truncate pt-0.5 text-right text-xs text-muted-foreground italic sm:block">
          {hint}
        </span>
      ) : null}
      {/* A rotated chevron reads as a rendering artifact, not as "leaves this
          section" — use a distinct glyph for rows that navigate away. */}
      {external ? (
        <ArrowUpRight
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden
        />
      ) : (
        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden
        />
      )}
    </Link>
  );
}
