"use client";

import * as React from "react";

import { PORTAL_TABS, PORTAL_TAB_LABELS as LABELS, type PortalTab } from "./portal-tabs";

/**
 * How a CROSS-REFERENCE reaches the selection this component owns.
 *
 * `PortalSectionLink` renders a real `<a href="?tab=…#portal-…">`, which is right for a
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
/** The account strip, left to right. The money column owns `invoices`. */
const ACCOUNT_TABS = ["plan", "methods", "details"] as const;

const SelectContext = React.createContext<
  ((next: PortalTab, opts?: { hash?: boolean }) => void) | null
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
   * The account column's selection, resolved HERE and nowhere else.
   *
   * `invoices` is a money-column choice, so the account side falls back to its
   * first available section. That fallback used to be the literal `"plan"`, in two
   * places that had to agree — this component and a `[data-tab="invoices"] …
   * [data-pane="plan"]` rule in globals.css, whose own comment said "keep this list
   * in step with the strip's buttons".
   *
   * For a customer with NO subscription there is no plan pane, so both resolved to
   * a section that does not exist: no button pressed, no pane displayed, and a
   * strip of controls sitting over an empty column. Seen on the live portal
   * (invoice-only customer, 2026-09-07).
   *
   * Strip order, not pane order, so the pressed button is the leftmost one — the
   * panes deliberately render details-before-methods for a different reason (see
   * the note at the pane list).
   */
  const accountStrip = ACCOUNT_TABS.filter((id) => nodes[id] != null);
  const accountTab = tab === "invoices" ? accountStrip[0] : tab;
  const navRef = React.useRef<HTMLElement>(null);

  const select = React.useCallback((next: PortalTab, opts?: { hash?: boolean }) => {
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
        <div className="portal-col portal-col-money">
          <div className="portal-pinned flex flex-col gap-4">
            {setup}
            {balance}
          </div>
          <div id="portal-invoices" className="portal-pane" data-pane="invoices">
            {invoices}
          </div>
        </div>

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
          /* A 2×2 GRID on a phone, a wrapping row from `sm` up.
             The four pills need 456px in a 348px box, so they cannot share one row at
             any phone width. `flex-wrap` gave a ragged 3-then-1 slab; a single scrolling
             row fitted in 46px but put the fourth pill off screen, and a buyer has no
             reason to suspect a nav strip scrolls. Nothing on a billing portal may be
             discoverable only by swiping — so the height stays and the raggedness goes.
             Equal cells, every label on screen, no hidden state. */
          className="portal-tabs grid w-full grid-cols-2 items-center gap-2 sm:flex sm:w-fit sm:flex-wrap"
          aria-label="Billing sections"
          onKeyDown={onKeyDown}
        >
          {shown.map((id) => {
            const on = id === tab;
            return (
              <button
                key={id}
                type="button"
                data-tab-btn={id}
                aria-pressed={on}
                onClick={() => select(id)}
                className={[
                  "inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold whitespace-nowrap sm:w-auto sm:justify-start sm:px-3.5",
                  "transition-colors",
                  /* Reads two ways at once, which is what this control has to do. The rail
                     plus exactly one FILLED item is the tab-switcher grammar; every item
                     being a raised pill — rather than a bare word — is what gives each one
                     the weight of a call to action.

                     The fill is `--foreground` (ink), NOT `--solid`. On the operator
                     dashboard those are the same near-black, so `--solid` would have looked
                     right in review — but this is a HOSTED page, and `brandCss` rewrites
                     `--solid` to the merchant's raw brand colour (`lib/brand.ts`). A
                     `bg-solid` pill therefore comes out full-strength brand — orange for an
                     orange merchant — on a control that is navigation, not the page's
                     primary action. `--foreground` is not in the list `brandCss` overrides,
                     so this stays ink in every merchant's palette. It is also the app's own
                     active-tab idiom: `ui/tabs.tsx` draws its active indicator with
                     `bg-foreground`. `--primary` is unusable here for a second reason — it
                     is the link/accent colour and is never a fill. */
                  /*
                   * THE BUTTON VOCABULARY, not the tab one — and the rail is gone with it.
                   *
                   * Reviewed 2026-09-15: "Doesn't feel clickable." The strip was a
                   * `bg-accent` rail holding borderless `bg-card` pills, which on a phone
                   * (no hover) left `shadow-xs` as the only affordance; four white boxes
                   * on lavender read as a legend.
                   *
                   * `ui/tabs.tsx` would say the fix is NOT a border — its triggers carry
                   * `border border-transparent` and show selection by fill alone. But this
                   * control is documented right below as deliberately NOT a tablist: it is
                   * a pressed-button group. So the right vocabulary is `ui/button.tsx`,
                   * whose `outline` variant IS `border … shadow-xs`.
                   *
                   * ⚠️ `border-input`, and it took two measurements to get here.
                   * Inside the old rail, `--border` (#e2e9f2) on `--accent` (#e8eef7) was
                   * 1.05:1 — an edge in the DOM and nowhere on screen. Dropping the rail
                   * did not rescue it: on the storefront ground the same token measures
                   * 1.14:1 border-vs-ground and 1.07:1 fill-vs-ground, i.e. WORSE, because
                   * the rail had been supplying the separation.
                   * `--input` is not a borrowed field token here — `ui/button.tsx`'s own
                   * outline variant carries `dark:border-input` for exactly this reason:
                   * where `--border` cannot be seen against the surface, the outline button
                   * uses `--input`. Light mode on a tinted buyer ground is that case.
                   *
                   * The LABEL is `text-primary`, and that is a semantic claim rather than a
                   * decorative one: this design system defines `--primary` as "this links or
                   * navigates", which is exactly what these do. A grey outline says "I am a
                   * discrete object"; the accent says "I am interactive", in the vocabulary
                   * the product already uses for ~96 links. Measuring contrast only ever
                   * proved the edge was VISIBLE — it never proved the control read as
                   * pressable, and those are different questions.
                   * Safe on a hosted page: `brandCss` rewrites `--primary` to the MERCHANT's
                   * hex contrast-corrected to AA as link text (`readableOn`), unlike
                   * `--solid`, which keeps the raw hex for fills. So it is on-brand and
                   * readable by construction, and the note above about `--primary` never
                   * being a FILL still stands — this is text.
                   */
                  on
                    ? "border border-foreground bg-foreground text-background shadow-sm"
                    : "border border-input bg-card text-foreground shadow-xs hover:bg-muted active:bg-muted",
                ].join(" ")}
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
          THE ACCOUNT SIDE IS TABBED ON A DESKTOP TOO, and only here.

          Two columns could not hold all four sections: the account column needs plan
          (299) + billing details (372) + payment methods (578) ≈ 1281px against the
          ~771px above a 900px fold, so whichever went last was the one below it. Making
          the WHOLE page tabs would have fixed that and thrown away the reason for two
          columns — a 1600px screen showing a balance and one card.

          So the money stays put and only the account side takes turns. Invoices is what
          a buyer opens a billing link for, and it is never behind a click; everything
          else is one. Below 1000px this strip is hidden and the four-way filter above
          takes over, because there is no width to keep anything permanent.
        */}
          <nav
            className="portal-side-tabs flex w-fit flex-wrap items-center gap-2"
            aria-label="Account sections"
          >
            {accountStrip.map((id) => {
              const on = accountTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => select(id)}
                  className={[
                    "inline-flex h-9 items-center rounded-md px-3.5 text-sm font-semibold whitespace-nowrap transition-colors",
                    /* Same idiom as the narrow-screen filter above — see the note there,
                       including why the fill is `--foreground` and not `--solid`. This
                       strip needed the weight most: it is the ONLY route to two of the
                       four sections on a desktop, and as three unfilled grey words it did
                       not read as a control at all. */
                    /* Same borders as the narrow-screen filter above — one idiom. */
                    on
                      ? "border border-foreground bg-foreground text-background shadow-sm"
                      : "border border-input bg-card text-foreground shadow-xs hover:bg-muted active:bg-muted",
                  ].join(" ")}
                >
                  {LABELS[id]}
                </button>
              );
            })}
          </nav>
          {/* Billing details BEFORE payment methods, which also restores the order the
            single-column page had and documented: it is the PREREQUISITE for adding a
            method (`AddCard` refuses to start a setup without an address), so it reads
            in the order the buyer needs it.

            It matters more in two columns than it did in one. Payment methods is the
            tallest block here — a mandate-status line per instrument — so with it first,
            billing details started below the fold and the buyer had to scroll to reach
            the thing the section above it depends on. */}
          {(["plan", "details", "methods"] as const).map((id) =>
            nodes[id] == null ? null : (
              <div key={id} id={`portal-${id}`} className="portal-pane" data-pane={id}>
                {nodes[id]}
              </div>
            ),
          )}
        </div>
      </div>
    </SelectContext.Provider>
  );
}
