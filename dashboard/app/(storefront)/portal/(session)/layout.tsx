import type { ReactNode } from "react";

/**
 * Buyer-facing portal chrome (P14) — deliberately minimal. Buyers are not
 * logged-in dashboard users, so the root layout renders its bare (no-sidebar)
 * branch around this. NOTHING under /portal may import lib/api.ts (org-key
 * client) — auth is the customer-scoped portal token in the URL.
 */
export default function PortalLayout({ children }: { children: ReactNode }) {
  return <div className="flex w-full flex-col gap-4 sm:gap-5">{children}</div>;
}
