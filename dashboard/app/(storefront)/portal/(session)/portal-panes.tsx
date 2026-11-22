"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import { PORTAL_TABS, PORTAL_TAB_LABELS as LABELS, type PortalTab } from "./portal-tabs";

/*
 * Underlined text tabs (decided 2026-11-17, replacing the ink-filled pill). The label is
 * `text-primary` — the brand-corrected link colour, which says "this navigates" (the
 * September review found grey words did not read as a control); the selected one is ink
 * with a 2px rule. Never `--solid`: on a hosted page that is the merchant's raw fill.
 */
const TAB =
  "-mb-px inline-flex h-10 items-center gap-2 border-b-2 text-sm font-medium whitespace-nowrap transition-colors";
const TAB_ON = "border-foreground text-foreground";
const TAB_OFF = "border-transparent text-primary hover:border-border";
/** The one underline that glides to the selected tab; the tab's own shows until it lands. */
const UNDERLINE =
  "rounded-none border-b-2 border-foreground bg-transparent shadow-none ease-(--ease-glide)";

/**
 * How a CROSS-REFERENCE reaches the selection this component owns.
 *
 * `PortalSectionLink` renders a real anchor to `?tab=…#portal-…`, which is right for a
 * first load, a new tab, or JS off — the server resolves the opening section from that
 * parameter. But an in-app click on it used to change only the URL: this component seeds
 * `tab` from `initialTab` with `useState`, and a client-side navigation does not remount
 * it, so the fresh prop was ignored and the strip stayed where it was. Reported from the
 * live portal 2026-09-01: "it doesn't change the tab on right, only top url changes".
 *
 * Syncing the prop back into state would fix that one case and leave a worse one. `select`
 * writes the URL with `replaceState` ON PURPOSE (see below), which Next's router never
 * observes — so after any tab tap the router's idea of the current URL is stale, and a link
 * to the section it *thinks* is current can be skipped as a no-op navigation, changing
 * nothing and re-rendering nothing.
 *
 * So the link does not navigate at all when it is inside these panes: it calls the same
 * `select` the buttons call. ONE mechanism, no round trip, nothing to get out of step.
 * Outside the panes there is no provider, the handler bows out, and the anchor behaves
 * like any other link.
 */
/** The strip under the plan, left to right. The plan itself is permanent above it. */
const ACCOUNT_TABS = ["invoices", "methods", "details"] as const;

export type PortalSelectOpts = {
  hash?: boolean;
  /** An element inside the pane to bring into view instead of the pane's top. */
  anchor?: string;
};

const SelectContext = React.createContext<
  ((next: PortalTab, opts?: PortalSelectOpts) => void) | null
>(null);

/** Null when rendered outside `PortalPanes` — callers must fall back to plain navigation. */
export function usePortalSelect() {
  return React.useContext(SelectContext);
}

/**
 * The portal's responsive shell: a two-column layout at ≥1000px, a section filter
 * below it. The LAYOUT lives in `globals.css` under `.portal-panes` — read the block
 * there first, it carries the reasoning. This component owns one thing: which section
 * is selected on a narrow screen.
 *
 * Sections arrive as props rather than children so the two columns can be composed
 * here in one place. They are rendered by the SERVER component that passes them in,
 * so nothing under `/portal` becomes client-side because of this file.
 */

export function PortalPanes({
  initialTab,
  dueCount,
  setup,
  balance,
  invoices,
  plan,
  methods,
  details,
}: {
  /** Resolved on the server so the first paint is already the right section. */
  initialTab: PortalTab;
  /** Open invoices, shown on the Invoices control. 0 renders no badge. */
  dueCount: number;
  /**
   * What the buyer still has to set up, above the balance and above the filter.
   * Null once there is nothing to do — see `SetupCard`, which renders nothing then.
   */
  setup: React.ReactNode;
  balance: React.ReactNode;
  invoices: React.ReactNode;
  /** Null for a customer with no subscription — then there is no pane and no control. */
  plan: React.ReactNode;
  methods: React.ReactNode;
  details: React.ReactNode;
}) {
  const nodes: Record<PortalTab, React.ReactNode> = { invoices, plan, methods, details };
  /**
   * Only sections that actually rendered something. A customer with no subscription
   * would otherwise get a "Your plan" control that selects a blank screen — the
   * house rule is to omit a control rather than ship one that does nothing.
   */
  const shown = PORTAL_TABS.filter((id) => nodes[id] != null);

  const [tab, setTab] = React.useState<PortalTab>(
    shown.includes(initialTab) ? initialTab : (shown[0] ?? "invoices"),
  );

  /**
   * The strip's selection under the plan, resolved HERE and nowhere else. `plan` is
   * permanent above the strip on a desktop, so choosing it (a phone tab, or a `?tab=plan`
   * link) falls back to the strip's first available section — the CSS keys on
   * `data-account-tab`, never on `data-tab` with a fallback spelled out again. A customer
   * with no subscription has no plan pane and the strip still resolves to a real section.
   */
  const accountStrip = ACCOUNT_TABS.filter((id) => nodes[id] != null);
  const accountTab = tab === "plan" ? accountStrip[0] : tab;
  const navRef = React.useRef<HTMLElement>(null);

  const select = React.useCallback((next: PortalTab, opts?: PortalSelectOpts) => {
    setTab(next);
    /**
     * Reflected into the URL so a reload, a back button, or a redirect from a gateway
     * lands on the section the buyer was in. `replaceState` rather than a router push:
     * this is a view filter, not a navigation, and pushing would make Back walk
     * backwards through tabs instead of leaving the portal. It also avoids a server
     * round-trip on every tap.
     *
     * Above the breakpoint the filter is hidden and this never runs, so the parameter
     * only ever appears on the screens where it means something.
     */
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    /**
     * A cross-reference also carries the hash and brings the section into view, which is
     * what the anchor used to do natively before this handler took the click. Deferred a
     * turn because the pane it scrolls to may still be `display: none` at this point on a
     * narrow screen — measuring its position before the selection paints scrolls nowhere.
     * A tab TAP passes no hash: the pane it selects is already where the buyer is looking.
     *
     * SCROLL ONLY IF THE PANE IS NOT ALREADY USEFULLY ON SCREEN — and the test is explicit,
     * because NEITHER `scrollIntoView` keyword expresses it. Both were measured here:
     *   · `block: "start"` always scrolls. On a wide screen the account pane is normally
     *     fully visible already, so it pinned the pane's top to the viewport's and pushed
     *     the balance and the alert the buyer had just read up off screen. Reported on the
     *     live portal 2026-09-01: "it scrolls down unnecessarily even if it's in viewport".
     *   · `block: "nearest"` then under-scrolls in the one case that needs it: at 480×820 the
     *     methods pane sits at top 744, so its top edge is technically inside the viewport,
     *     `nearest` calls that visible and does nothing — leaving 76px of a tall section on
     *     screen. Measured, not assumed; the keyword reads like the right one and is not.
     * So: require a real amount of the pane to be visible — all of it when it is short, at
     * least 200px when it is tall — and otherwise bring its start to the top.
     */
    if (opts?.hash) url.hash = `portal-${next}`;
    window.history.replaceState(null, "", url);
    if (opts?.hash) {
      setTimeout(() => {
        // An anchor (the add-method form) is a target the buyer must SEE whole: scroll
        // unless its top is already in the upper part of the screen.
        const target = opts.anchor ? document.getElementById(opts.anchor) : null;
        if (target) {
          const t = target.getBoundingClientRect().top;
          if (t < 0 || t > window.innerHeight * 0.4)
            target.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        const pane = document.getElementById(`portal-${next}`);
        if (!pane) return;
        const r = pane.getBoundingClientRect();
        const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
        if (visible < Math.min(r.height, 200)) {
          pane.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      }, 0);
    }
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const i = shown.indexOf(tab);
    const next = shown[(i + delta + shown.length) % shown.length];
    if (!next) return;
    select(next);
    navRef.current?.querySelector<HTMLButtonElement>(`[data-tab-btn="${next}"]`)?.focus();
  }

  return (
    <SelectContext.Provider value={select}>
      <div className="portal-panes" data-tab={tab} data-account-tab={accountTab}>
        {/*
        Deliberately NOT `role="tablist"` / `role="tab"` / `role="tabpanel"`. Above
        1000px this whole element is `display: none` and every section is on screen at
        once — tab semantics would describe a widget that is not there, leaving a
        screen reader with tabpanels and no tablist. A pressed-button group is what
        this actually is on both screens: a filter over sections that keep their own
        headings either way.
      */}
        <nav
          ref={navRef}
          /* Underlined tabs that WRAP on a narrow phone rather than scroll: nothing on a
             billing portal may be discoverable only by swiping, so every label stays on
             screen even when the fourth one drops to a second line. */
          className="portal-tabs relative isolate flex w-full flex-wrap items-end gap-x-5 border-b"
          aria-label="Billing sections"
          onKeyDown={onKeyDown}
        >
          <SegmentIndicator className={UNDERLINE} />
          {shown.map((id) => {
            const on = id === tab;
            return (
              <button
                key={id}
                type="button"
                data-tab-btn={id}
                aria-pressed={on}
                onClick={() => select(id)}
                className={cn(TAB, on ? cn(TAB_ON, "segment-on") : TAB_OFF)}
              >
                {LABELS[id]}
                {id === "invoices" && dueCount > 0 ? (
                  <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-xs leading-none font-semibold text-warning">
                    {dueCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="portal-col portal-col-account">
          {/*
          THE PLAN LEADS (decided 2026-11-17). On a desktop this is the main, wider column:
          the plan card is permanent at the top, and invoices, billing details and payment
          methods take turns under it behind one underlined strip. The balance sits in the
          narrower column beside it. Below 1000px this strip is hidden and the four-way
          filter above takes over, because there is no width to keep anything permanent.
        */}
          {/* Billing details BEFORE payment methods, which also restores the order the
            single-column page had and documented: it is the PREREQUISITE for adding a
            method (`AddCard` refuses to start a setup without an address), so it reads
            in the order the buyer needs it.

            It matters more in two columns than it did in one. Payment methods is the
            tallest block here — a mandate-status line per instrument — so with it first,
            billing details started below the fold and the buyer had to scroll to reach
            the thing the section above it depends on. */}
          {nodes.plan == null ? null : (
            <div id="portal-plan" className="portal-pane" data-pane="plan">
              {nodes.plan}
            </div>
          )}
          {/* The plan's strip sits between it and its panes on a desktop. */}
          <nav
            className="portal-side-tabs relative isolate flex w-full flex-wrap items-end gap-x-5 border-b"
            aria-label="Account sections"
          >
            <SegmentIndicator className={UNDERLINE} />
            {accountStrip.map((id) => {
              const on = accountTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => select(id)}
                  className={cn(TAB, on ? cn(TAB_ON, "segment-on") : TAB_OFF)}
                >
                  {LABELS[id]}
                  {id === "invoices" && dueCount > 0 ? (
                    <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-xs leading-none font-semibold text-warning">
                      {dueCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          {(["invoices", "details", "methods"] as const).map((id) =>
            nodes[id] == null ? null : (
              <div key={id} id={`portal-${id}`} className="portal-pane" data-pane={id}>
                {nodes[id]}
              </div>
            ),
          )}
        </div>

        {/* After the plan column in the DOM, so a keyboard or screen reader reaches the plan
            first on a desktop (WCAG 2.4.3); CSS places it in the right column there, and at
            the top on a phone (`order: 1`). */}
        <div className="portal-col portal-col-money">
          <div className="portal-pinned flex flex-col gap-4">
            {setup}
            {balance}
          </div>
        </div>
      </div>
    </SelectContext.Provider>
  );
}
