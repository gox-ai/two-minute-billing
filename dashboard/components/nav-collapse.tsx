"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The rail's collapsed/expanded state.
 *
 * ── Why a data attribute and not a prop ───────────────────────────────────────
 * The `<aside>` is a SERVER component holding a mix of server bits (the avatar, the
 * sign-out form) and client ones (nav, mode toggle, org switcher). Threading a
 * boolean through it would mean making the whole rail client-side. Instead the
 * state is written to `document.documentElement.dataset.nav` and the widths and
 * label hiding are CSS in `globals.css` — the same idiom the portal panes use, and
 * it leaves the server/client split alone.
 *
 * The context exists only for the parts that need to REACT rather than restyle:
 * a nav group whose children have no icons cannot be shown collapsed, so clicking
 * one opens the rail instead of toggling the group.
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 * `localStorage`, per browser, like the theme. Read in an inline script in the
 * layout head so a hard load paints the rail at its stored width — reading it in
 * an effect here would show an expanded rail for a frame and then snap it shut.
 * Every access is wrapped: a private window or blocked site data throws on read,
 * and a nav that cannot remember its width must still render.
 */
const KEY = "tmb:nav-collapsed";

interface NavCollapseValue {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
}

const Ctx = React.createContext<NavCollapseValue>({
  collapsed: false,
  setCollapsed: () => {},
});

/** Null-safe: a component outside the provider simply behaves as expanded. */
export function useNavCollapse() {
  return React.useContext(Ctx);
}

export function NavCollapseProvider({ children }: { children: React.ReactNode }) {
  // Starts false so the first client render matches the server's markup exactly;
  // the effect below then adopts whatever the inline script put on <html>. The
  // VISUALS do not wait for that — CSS is already reading the attribute — so this
  // state only settles the toggle's own icon and label.
  const [collapsed, setCollapsedState] = React.useState(false);

  React.useEffect(() => {
    // Adopting the attribute the inline script already set IS synchronising with an
    // external system, which is what the lint rule says effects are for — but it
    // cannot see that. The alternative is worse: reading `document` in the useState
    // initialiser would have the server render one icon for this button and the
    // client another, which is a hydration mismatch. Same reason next-themes settles
    // the theme in an effect rather than during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsedState(document.documentElement.dataset.nav === "collapsed");
  }, []);

  const setCollapsed = React.useCallback((next: boolean) => {
    setCollapsedState(next);
    if (next) document.documentElement.dataset.nav = "collapsed";
    else delete document.documentElement.dataset.nav;
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* blocked storage — the width just will not survive a reload */
    }
  }, []);

  const value = React.useMemo(() => ({ collapsed, setCollapsed }), [collapsed, setCollapsed]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The script that applies the stored width BEFORE first paint. Rendered in the
 * dashboard layout's head; mirrors how next-themes avoids a flash of the wrong
 * theme. Kept tiny and total — any failure leaves the rail expanded.
 */
export const NAV_COLLAPSE_SCRIPT = `try{if(localStorage.getItem('${KEY}')==='1'){document.documentElement.dataset.nav='collapsed'}}catch(e){}`;

/**
 * The rail's collapse control: a small disc centred on the rail's border at mid-height,
 * clear of the business card. The chevron points the way the rail will move.
 * ⌘\ / Ctrl+\ does the same from anywhere. The caller's `<aside>` must be positioned.
 */
export function NavCollapseToggle({ className }: { className?: string }) {
  const { collapsed, setCollapsed } = useNavCollapse();
  const Icon = collapsed ? ChevronRight : ChevronLeft;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setCollapsed(document.documentElement.dataset.nav !== "collapsed");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCollapsed]);

  const label = collapsed ? "Expand navigation" : "Collapse navigation";
  return (
    <button
      type="button"
      onClick={() => setCollapsed(!collapsed)}
      // Below 768px the rail is a drawer with only one width, so globals.css hides
      // this control by attribute rather than the caller having to know.
      data-collapse-toggle=""
      // `aria-expanded` describes the rail, and the label says which way the press
      // goes — an icon alone leaves a screen reader with "button".
      aria-expanded={!collapsed}
      aria-label={label}
      aria-keyshortcuts="Meta+Backslash Control+Backslash"
      title={`${label} (⌘\\)`}
      className={cn(
        // Centre sits on the aside's right border, so the disc straddles the hairline.
        "absolute top-1/2 left-full z-30 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center",
        "rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground/50 shadow-sm",
        "transition-colors hover:text-sidebar-foreground",
        "focus-visible:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        // The disc is 24px; widen the hit area to 44px without changing what is drawn.
        "before:absolute before:-inset-2.5 before:content-['']",
        className,
      )}
    >
      <Icon strokeWidth={2.5} className="size-3.5" />
    </button>
  );
}
