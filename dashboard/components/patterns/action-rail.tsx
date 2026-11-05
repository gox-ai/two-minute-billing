import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Right actions rail: grouped text-link actions under small headings,
 * separated by rules, with an optional red danger action at the
 * bottom. Children of ActionGroup are links/buttons/ActionButtons — anything.
 *
 * ⚠️ It was `hidden … xl:block`, so **every action on a detail page vanished
 * below 1280px** — not just on phones but on iPad landscape and any 1366×768
 * laptop. Measured on subscription detail: 9 actions present in the DOM,
 * `display:none`, with no other surface offering them (Pause, Cancel, Edit,
 * Add charge and Remove discount exist ONLY here). Now it renders at every
 * width: a bordered card above the content when the layout is single-column,
 * the sticky 240px side column from `xl` up.
 *
 * Kept as ONE instance rather than a desktop aside plus a mobile drawer: the
 * children include dialog triggers and forms, and mounting them twice would
 * duplicate their DOM ids and form state.
 */
export function ActionRail({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "anim-rise w-full shrink-0 space-y-4 rounded-xl border bg-card p-4",
        // Actions first while stacked — the page header already carries identity
        // and status, and a detail page is otherwise a long read to scroll past.
        "order-first",
        "xl:sticky xl:top-20 xl:order-0 xl:w-60 xl:self-start xl:rounded-none xl:border-0 xl:bg-transparent xl:p-0",
        className,
      )}
      style={{ animationDelay: "120ms" }}
    >
      {children}
    </aside>
  );
}

export function ActionGroup({
  heading,
  children,
  className,
}: {
  heading?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-1 border-b border-border/70 pb-4 last:border-0 last:pb-0", className)}
    >
      {heading ? (
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {heading}
        </h3>
      ) : null}
      {/* The rail is a hard 240px, so nothing in it may be wider than its own column.
          `<Button>` carries `whitespace-nowrap` in its base class, so an ActionButton
          whose label comes from data — `Remove discount (DEVELOPER-100-4-DEBUGGIN)` —
          ran past the rail and gave the page a horizontal scrollbar, while the
          RailLinks beside it wrapped. Constrain the children rather than each caller.

          DESCENDANTS, not children: an ActionButton wrapped in an ActionForm renders
          `button < form < div`, so a direct-child rule styles the form and leaves the
          button's `nowrap` intact — measured on the customer rail, which escaped by
          102px while the invoice rail (no form) looked fixed. */}
      {/* Two columns while the rail is a full-width card, so a nine-action group
          is ~5 rows instead of 9 and the content below stays in reach. One
          column again once it is the 240px side rail. */}
      <div className="grid w-full grid-cols-2 items-start gap-x-4 gap-y-1 text-sm **:max-w-full **:text-left **:whitespace-normal xl:flex xl:flex-col">
        {children}
      </div>
    </div>
  );
}

/**
 * One look for EVERY rail item. The rail is uniform text links, so a rail item
 * that opens a dialog must be indistinguishable from one that navigates —
 * ours previously rendered dialog triggers as boxed <Button>s and navigations as
 * bare links, which read as broken wherever the two sat next to each other.
 */
export const railItemClass =
  "rounded px-1 py-0.5 text-left text-sm break-words transition-colors hover:underline";
export const railToneClass = (danger?: boolean) => (danger ? "text-destructive" : "text-primary");

/** A single rail action rendered as a link. */
export function RailLink({
  href,
  children,
  danger,
  className,
}: {
  href: string;
  children: React.ReactNode;
  danger?: boolean;
  className?: string;
}) {
  return (
    <Link href={href} className={cn(railItemClass, railToneClass(danger), className)}>
      {children}
    </Link>
  );
}

/**
 * A rail action that opens something instead of navigating. Looks exactly like
 * RailLink. `opensDialog` sets `aria-haspopup="dialog"`, which our dialog triggers
 * were missing — that omission is why tooling could not tell them from inert
 * buttons, and why screen readers get no warning that a dialog is coming.
 */
export function RailButton({
  onClick,
  children,
  danger,
  disabled,
  opensDialog,
  expanded,
  className,
  type = "button",
}: {
  onClick?: () => void;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  opensDialog?: boolean;
  expanded?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-haspopup={opensDialog ? "dialog" : undefined}
      aria-expanded={opensDialog ? !!expanded : undefined}
      className={cn(
        railItemClass,
        railToneClass(danger),
        "disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50 hover:disabled:no-underline",
        className,
      )}
    >
      {children}
    </button>
  );
}
