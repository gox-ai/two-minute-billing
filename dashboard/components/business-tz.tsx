"use client";

import * as React from "react";

/**
 * The timezone dates render in — the current business's, falling back to the
 * organization's.
 *
 * Dates must render in the **business** timezone, not UTC: the engine's term
 * boundaries are the start of the day in `businesses.timezone` and proration is
 * whole-day (`db/schema/tenancy.ts`). Rendering a midnight-IST boundary in UTC
 * showed it as `18:30` the previous day — an off-by-one-day lie on every renewal
 * date we display.
 *
 * Why a context and not a prop: ~30 client table components render dates, and
 * threading a `tz` prop through every one plus its call site is a lot of churn for
 * a value that is constant for the whole `/businesses/[biz]` subtree. The provider
 * is set once in that layout, so any client component — including ones added later
 * — gets the right zone for free.
 *
 * `null` from `useBusinessTz()` is still the honest value **outside** a business
 * scope (`/audit`, `/developer` span many businesses, so no single BUSINESS
 * timezone applies). What changed in 0216: that case no longer means UTC. Those
 * org-scoped screens now render in the ORGANIZATION's own timezone
 * (`organizations.timezone`, set on `/settings`), provided by `OrgTzProvider` in
 * `app/(dashboard)/layout.tsx` and resolved by **`useDisplayTz()`** —
 * business → organization → UTC. UTC survives as the last fallback, which is what an
 * org that has never set one gets, so nothing changed for anyone who does not use the
 * setting.
 *
 * Use `useDisplayTz()` for anything you render. `useBusinessTz()` is kept — unchanged
 * — for the handful of places that genuinely need to know whether a BUSINESS zone
 * applies (rather than what to format with), and because ~30 components call it.
 *
 * Server components cannot read React context — they resolve the business row
 * themselves and pass `tz` to `fmtDate`/`fmtDateTime` explicitly, or call
 * `orgTz()` from `lib/org-tz-server.ts` on an org-scoped screen.
 */
const BusinessTzContext = React.createContext<string | null>(null);

/**
 * The organization's display timezone. Separate from the business context on
 * purpose: they have different lifetimes (this one is set once for the whole
 * signed-in shell, the business one per `/businesses/[biz]` subtree) and
 * `useDisplayTz` needs to see both to prefer the narrower one.
 */
const OrgTzContext = React.createContext<string | null>(null);

export function BusinessTzProvider({
  tz,
  children,
}: {
  tz: string | null;
  children: React.ReactNode;
}) {
  return <BusinessTzContext.Provider value={tz}>{children}</BusinessTzContext.Provider>;
}

export function OrgTzProvider({ tz, children }: { tz: string | null; children: React.ReactNode }) {
  return <OrgTzContext.Provider value={tz}>{children}</OrgTzContext.Provider>;
}

/** The business timezone, or `null` outside a business scope. */
export function useBusinessTz(): string | null {
  return React.useContext(BusinessTzContext);
}

/** The organization's display timezone, or `null` when it has never been set. */
export function useOrgTz(): string | null {
  return React.useContext(OrgTzContext);
}

/**
 * The zone to FORMAT in: the business's if we are inside one, else the
 * organization's, else UTC. Never null — a caller has nothing useful to do with
 * "unknown" other than pick UTC, and having each of them re-derive that is how the
 * fallback drifts.
 */
export function useDisplayTz(): string {
  const biz = React.useContext(BusinessTzContext);
  const org = React.useContext(OrgTzContext);
  return biz || org || "UTC";
}
