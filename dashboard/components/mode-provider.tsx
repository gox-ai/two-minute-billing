"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * The ONE answer to "is what I'm looking at live or test".
 *
 * Every business has a live mode and a test mode: two business rows, the test one
 * pointing at its live twin (`live_business_id`). The mode on screen is therefore a FACT
 * of the business in the route — never a preference. Outside a business everything is
 * live: org-level views (overview, metrics) report live businesses only.
 *
 * Inside a business, `ModeToggle` switches to the twin and keeps the same section. A
 * standalone test business (created before twins existed) has no live twin, so there
 * is nothing to switch to.
 */

export type DashboardMode = "live" | "test";

/** The slice of a business this resolver needs. */
export interface ModeBizRef {
  id: string;
  livemode: DashboardMode;
  /** On a test business: its live twin. */
  liveBusinessId?: string | null;
  /** On a live business: its test twin, once it exists. */
  testBusinessId?: string | null;
}

export interface DashboardModeState {
  /** The mode that actually applies to what is on screen. */
  mode: DashboardMode;
  /** True when `mode` came from the business being viewed. */
  scoped: boolean;
  /** The business being viewed, when there is one. */
  business?: ModeBizRef;
}

const ModeContext = React.createContext<DashboardModeState | null>(null);

/** The business segment of a dashboard path, or null at the org level. */
export const bizIdFromPath = (path: string): string | null =>
  path.match(/^\/businesses\/([^/]+)/)?.[1] ?? null;

export function ModeProvider({
  businesses,
  children,
}: {
  businesses: ModeBizRef[];
  children: React.ReactNode;
}) {
  const path = usePathname();
  const value = React.useMemo<DashboardModeState>(() => {
    const biz = bizIdFromPath(path);
    if (!biz) return { mode: "live", scoped: false };
    const found = businesses.find((b) => b.id === biz);
    // Not in the list — the layout's `listBusinesses()` threw, or this id is not ours.
    // Leave `scoped` false rather than asserting a mode we cannot prove.
    if (!found) return { mode: "live", scoped: false };
    return { mode: found.livemode, scoped: true, business: found };
  }, [path, businesses]);
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

/**
 * Null outside the signed-in shell (the login screen and the buyer storefront have
 * no mode). Callers render nothing rather than guessing.
 */
export function useDashboardMode(): DashboardModeState | null {
  return React.useContext(ModeContext);
}
