"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A menu of existing actions (dialog triggers, confirm buttons, forms, links).
 *
 * Not a Radix DropdownMenu: that unmounts its content on close and takes the
 * dialog an item just opened with it. This panel stays mounted and is only hidden,
 * so a dialog opened from it survives. Every link and button inside is restyled to
 * a menu row; a red item (`text-destructive`) keeps its colour.
 *
 * The panel is portalled to <body> and positioned under its trigger. Rendered in
 * place, it sat inside the header's stacking context (its entrance animation makes
 * one) and opened BEHIND the cards below it; inside a card it was clipped by the
 * card's `overflow-hidden`.
 */
export function MoreMenu({
  label = "More",
  icon,
  children,
}: {
  label?: string;
  /** Render a ⋯ icon button (row menus) instead of a labelled one. */
  icon?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const panelId = React.useId();

  React.useEffect(() => setMounted(true), []);

  const place = React.useCallback(() => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    // Right-aligned to the trigger, but never past either viewport edge (a phone's
    // header wraps More to the left), and scrollable when the space below is short.
    const vw = window.innerWidth;
    const width = Math.min(288, vw - 16);
    const right = Math.min(Math.max(vw - r.right, 8), vw - width - 8);
    const top = r.bottom + 8;
    setPos({ top, right, maxHeight: Math.max(window.innerHeight - top - 8, 160) });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The panel is fixed to the viewport; the page scrolls inside <main>, so any
    // scroll moves the trigger away from it.
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  const content = (
    <div
      ref={panel}
      id={panelId}
      hidden={!open}
      style={pos ? { top: pos.top, right: pos.right, maxHeight: pos.maxHeight } : undefined}
      // Close once an item handled its click; a dialog it opened is portalled out.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button,summary")) setOpen(false);
      }}
      className={cn(
        "fixed z-50 w-72 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg",
        open && "flex",
        // A row grows to a second line rather than run past the panel (labels can carry a code).
        "[&_:is(a,button)]:flex [&_:is(a,button)]:h-auto [&_:is(a,button)]:min-h-9 [&_:is(a,button)]:w-full [&_:is(a,button)]:items-center",
        "[&_:is(a,button)]:py-1.5 [&_:is(a,button)]:whitespace-normal",
        "[&_:is(a,button)]:justify-start [&_:is(a,button)]:rounded-md [&_:is(a,button)]:px-2.5",
        "[&_:is(a,button)]:text-left [&_:is(a,button)]:text-sm [&_:is(a,button)]:font-normal",
        "[&_:is(a,button)]:no-underline [&_:is(a,button):hover]:bg-muted [&_:is(a,button):hover]:no-underline",
        "[&_:is(a,button):not(.text-destructive)]:text-foreground [&_form]:w-full",
      )}
    >
      {children}
    </div>
  );

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size={icon ? "sm" : "default"}
        aria-label={icon ? label : undefined}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={icon ? "px-2" : undefined}
      >
        {icon ? (
          <MoreHorizontal aria-hidden className="size-4" />
        ) : (
          <>
            {label}
            <ChevronDown
              aria-hidden
              className={cn("size-4 transition-transform", open && "rotate-180")}
            />
          </>
        )}
      </Button>
      {/* Mounted from the first client render on, open or not, so a dialog opened from
          an item keeps its owner. */}
      {mounted ? createPortal(content, document.body) : null}
    </>
  );
}

export function MoreSection({
  heading,
  children,
}: {
  heading?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col border-b pb-1.5 not-first:pt-1.5 last:border-0 last:pb-0">
      {heading ? (
        <span className="px-2.5 pt-1.5 pb-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {heading}
        </span>
      ) : null}
      {children}
    </div>
  );
}
