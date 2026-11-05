"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

import { usePortalSelect } from "./portal-panes";
import type { PortalTab } from "./portal-tabs";

/**
 * A cross-reference from one portal section to another.
 *
 * Every one of these used to be plain text with a DIRECTION in it — "in Billing details
 * above", "again below", "you can pay them above". That was true exactly once, when the
 * portal was a single column. It is now two columns on a desktop with a tabbed account
 * side, and a filter on a phone, so "above" and "below" are wrong in both and the named
 * section may not even be on screen.
 *
 * So the reference became a control, and it names no direction. `?tab=` is what the
 * narrow layout and the desktop account strip both read (the server resolves the opening
 * section from it, so the first paint is already right), and the hash is what a wide
 * screen needs to bring an already-visible section into view. Each layout ignores the
 * half it does not need.
 *
 * Prefer this over writing a section's name in prose: a name the buyer cannot click is a
 * direction they have to find, and the layout has already changed under that copy twice.
 *
 * ⚠️ IT STAYS AN ANCHOR, and it does not navigate. Both halves matter.
 *
 * The `href` is real, so a first load, a shared URL, a middle click and JS-off all work —
 * the server reads `?tab=` and paints the right section. But an in-app click is handled
 * here instead: `PortalPanes` owns the selection in client state that a client-side
 * navigation does not remount, so navigating changed the URL and nothing else. Measured
 * on the live portal 2026-09-01 — the strip kept saying "Your plan" while the address bar
 * said `?tab=methods`. Calling the panes' own `select` is what makes the link a control
 * rather than a URL edit; see the context docblock in `portal-panes.tsx` for why syncing
 * the prop instead is not enough.
 *
 * A modified click (new tab, new window) is left to the browser, and outside the panes
 * there is no provider, so the anchor navigates normally.
 */
export function PortalSectionLink({
  section,
  children,
}: {
  section: PortalTab;
  children: ReactNode;
}) {
  const select = usePortalSelect();
  return (
    <Link
      href={`?tab=${section}#portal-${section}`}
      className="font-medium text-primary underline-offset-2 hover:underline"
      onClick={(e) => {
        if (!select) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        select(section, { hash: true });
      }}
    >
      {children}
    </Link>
  );
}

/**
 * The same cross-reference as a BUTTON, for the one place a section reference is the
 * page's primary action rather than an aside — the setup prompt above the balance, and
 * the add-card gate.
 *
 * Shares `PortalSectionLink`'s mechanism exactly (real `href`, in-app clicks handed to
 * the panes' own `select`), so read the docblock there first. It exists because prose
 * with a link in it is the weakest affordance we have, and it was carrying the two
 * things a buyer with nothing on file actually came here to do.
 *
 * FILLED, and that is deliberate on a hosted page. `brandCss` rewrites `--solid` to the
 * merchant's raw brand colour, so `variant="default"` renders full-strength brand — which
 * is wrong for a per-row preference (see the "Make primary" note in page.tsx) and right
 * here: this is the page's single call to action, and a filled button is the one place a
 * merchant's exact hex belongs. Never render two of these on one screen.
 */
export function PortalSectionButton({
  section,
  variant = "default",
  size,
  children,
}: {
  section: PortalTab;
  variant?: "default" | "outline";
  size?: "sm" | "default";
  children: ReactNode;
}) {
  const select = usePortalSelect();
  return (
    <Button asChild variant={variant} size={size}>
      <Link
        href={`?tab=${section}#portal-${section}`}
        onClick={(e) => {
          if (!select) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          select(section, { hash: true });
        }}
      >
        {children}
      </Link>
    </Button>
  );
}
