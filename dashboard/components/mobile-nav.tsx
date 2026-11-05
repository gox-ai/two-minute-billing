"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/wordmark";

/**
 * Navigation below 768px.
 *
 * The rail was `max-md:hidden` with nothing in its place, so on a phone the app
 * had no way to get anywhere — measured across 91 routes, the nav rendered on
 * none of them. This adds the trigger and the scrim; the panel itself is the
 * SAME `<aside>`, restyled off-canvas in `globals.css`.
 *
 * State goes on `<html data-mobile-nav>` rather than through props, matching
 * `nav-collapse.tsx`: the aside mixes server children (the avatar, the sign-out
 * form) with client ones, and threading a boolean would make the whole rail
 * client-side. It deliberately does NOT persist — a drawer that reopens itself
 * on the next page load is a bug, not a preference.
 */
const ATTR = "mobileNav";

function setOpen(open: boolean) {
  const el = document.documentElement;
  if (open) el.dataset[ATTR] = "open";
  else delete el.dataset[ATTR];
}

export function MobileNavTrigger({ className }: { className?: string }) {
  const [open, setOpenState] = React.useState(false);
  const pathname = usePathname();

  // Navigating is the drawer's whole purpose, so a completed navigation closes
  // it — otherwise the panel covers the page it just took you to. This is a
  // genuine external-system sync (the router, and the attribute on <html>), which
  // the lint rule cannot see — same exemption and reason as `nav-collapse.tsx`.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => {
    setOpenState(false);
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenState(false);
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpenState(next);
    setOpen(next);
  };

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        className={cn(
          "app-mobile-only inline-flex size-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted",
          className,
        )}
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>
      {/* A real button, so the drawer is dismissible by pointer and not only by
          Escape. Rendered always and toggled by opacity so it can transition;
          `pointer-events` keeps it inert while closed.
          Open, it INHERITS pointer-events: a modal menu opened by a tap disables
          the body before the tap's click lands, and a forced `auto` here caught
          that click and closed the drawer under the menu. */}
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={() => {
          setOpenState(false);
          setOpen(false);
        }}
        aria-label="Close navigation"
        className={cn(
          "app-mobile-only fixed inset-0 z-40 cursor-default bg-transparent transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
    </>
  );
}

/**
 * The mobile top bar: the only chrome above `<main>` below 768px, so it carries
 * the wordmark as well as the trigger. Hidden from `md` up, where the rail is
 * back and this would be a second, redundant header.
 */
export function MobileNavBar({ children }: { children?: React.ReactNode }) {
  return (
    <div className="app-mobile-only flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
      <MobileNavTrigger />
      <Wordmark size="sm" />
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}
