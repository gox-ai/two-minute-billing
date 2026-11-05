/**
 * Section identities for the portal's narrow-screen filter, in a module with NO
 * `'use client'` on purpose.
 *
 * The page is a SERVER component and resolves the opening section itself (so the first
 * paint is already right, with no flash). A helper exported from the client module
 * cannot be called from there — React refuses it at runtime, and nothing in the type
 * system says so. Keeping the plain values here means both halves share one definition.
 */

export const PORTAL_TABS = ["invoices", "plan", "methods", "details"] as const;
export type PortalTab = (typeof PORTAL_TABS)[number];

export const PORTAL_TAB_LABELS: Record<PortalTab, string> = {
  invoices: "Invoices",
  plan: "Your plan",
  methods: "Payment methods",
  details: "Billing details",
};

export function isPortalTab(v: string | undefined): v is PortalTab {
  return v !== undefined && (PORTAL_TABS as readonly string[]).includes(v);
}
