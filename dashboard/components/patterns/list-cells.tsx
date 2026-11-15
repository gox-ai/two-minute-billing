import * as React from "react";
import Link from "next/link";
import { StatusChip } from "@/components/patterns/chip";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The first column of every list — a two-line cell:
 * line 1 = status chip + bold linked name (+ any trailing chips), line 2 = the
 * mono id / email / sub-line.
 *
 * Each line has a fixed height (24px, the chip; then 20px), so every row of a list
 * that leads with this cell is the same height whether or not it carries a chip.
 */
export function InfoCell({
  status,
  title,
  href,
  sub,
  trailing,
  extra,
}: {
  /** Renders a `StatusChip` before the title when set. */
  status?: string | null;
  title: React.ReactNode;
  href?: string;
  /** Second line — the id (rendered mono) or any node for a custom sub-line. */
  sub?: React.ReactNode;
  /** Inline nodes after the title (extra chips, info icons). */
  trailing?: React.ReactNode;
  /** Additional lines under the sub-line. Avoid: a third line breaks the list's row rhythm. */
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex h-6 items-center gap-2">
        {status ? <StatusChip status={status} /> : null}
        {href ? (
          // `data-record-title`: the name glides into the record's title (lib/shared-title.ts).
          <Link
            href={href}
            data-record-title
            className="text-sm font-semibold text-foreground hover:text-primary hover:underline"
          >
            {title}
          </Link>
        ) : (
          <span className="text-sm font-semibold">{title}</span>
        )}
        {trailing}
      </span>
      {sub ? (
        <span className="flex h-5 items-center">
          {typeof sub === "string" ? (
            <span className="font-mono text-xs text-muted-foreground">{sub}</span>
          ) : (
            sub
          )}
        </span>
      ) : null}
      {extra}
    </div>
  );
}

/** Right-aligned money (`₹10,799.00`). The symbol names the currency; a code goes in the column head. */
export function MoneyCell({
  minor,
  currency,
  className,
}: {
  minor: number | null | undefined;
  currency: string | null | undefined;
  className?: string;
}) {
  if (minor == null || !currency) return <Dash />;
  return (
    <span className={cn("text-sm font-medium tabular-nums", className)}>
      {money(minor, currency)}
    </span>
  );
}

/** Muted secondary text with the em-dash fallback for blanks. */
export function TextCell({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const empty = children == null || children === "" || children === false;
  if (empty) return <Dash />;
  return <span className={cn("text-sm text-muted-foreground", className)}>{children}</span>;
}

/**
 * Long free text (descriptions, error messages, subjects). It WRAPS at `width` and is
 * never cut: a table must not hide part of a value behind an ellipsis.
 */
export function TruncateCell({
  value,
  width = "max-w-64",
  className,
  children,
}: {
  value?: string | null;
  width?: string;
  className?: string;
  /** Rendered in the cell instead of `value` (e.g. a muted code prefix); `value` stays the tooltip. */
  children?: React.ReactNode;
}) {
  if (!value) return <Dash />;
  return (
    <span
      className={cn(
        "block text-sm wrap-break-word whitespace-normal text-muted-foreground",
        width,
        className,
      )}
    >
      {children ?? value}
    </span>
  );
}

/**
 * Mono id, optionally linked.
 *
 * `width` opts into ellipsising rather than letting a column grow. Our ids run ~31
 * chars (`cus_…`), so an untruncated column pushed the money/date columns
 * off-screen. Off by default so lists with short ids are unaffected; the full value
 * stays in the tooltip.
 *
 * `external` leaves the app: a plain anchor in a new tab, not a `next/link` (which
 * would try to route an absolute URL through the router). Used for an id that lives
 * on someone else's dashboard — a gateway's own charge id.
 */
export function IdCell({
  id,
  href,
  width,
  external,
  plain,
}: {
  id?: string | null;
  href?: string;
  width?: string;
  external?: boolean;
  /** A number such as INV-229: a name, so sans text, not a mono id. */
  plain?: boolean;
}) {
  if (!id) return <Dash />;
  const cls = cn(
    plain ? "text-sm whitespace-nowrap" : "font-mono text-xs",
    "text-muted-foreground",
    width && `block truncate ${width}`,
  );
  if (!href)
    return (
      <span className={cls} title={width ? id : undefined}>
        {id}
      </span>
    );
  const linkCls = cn(cls, "hover:text-primary hover:underline");
  if (external)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={linkCls} title={id}>
        {id}
      </a>
    );
  return (
    <Link href={href} className={linkCls} title={width ? id : undefined}>
      {id}
    </Link>
  );
}

/**
 * A count in a list cell that reveals WHAT it counts on hover or focus — the addons
 * riding a subscription, the customer's other subscriptions. "+2 addons" alone makes
 * the reader open the row to find out which two.
 *
 * The trigger is a real button so the keyboard reaches it; the panel is a hover card
 * rather than a tooltip because its rows can be links.
 */
export function PeekBadge({
  label,
  title,
  children,
  align = "start",
}: {
  /** The badge text itself, e.g. `+2 addons`. */
  label: string;
  /** Heading above the list, e.g. `Addons (2)`. */
  title: string;
  children: React.ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="shrink-0 cursor-default rounded-full bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {label}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align={align} className="p-0">
        <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
          {title}
        </div>
        <div className="flex flex-col gap-2 px-3 py-2.5">{children}</div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The em dash shown for every empty value. */
export function Dash() {
  return <span className="text-sm text-muted-foreground">—</span>;
}
