"use client";

import { CommandPalette, GoToRow, type CommandAction } from "@/components/command-palette";
import { NavIcon, type NavItem } from "@/components/SideNav";
import type { BizRef } from "@/components/AppNav";

// NB: client components used from the server layout must be TOP-LEVEL exports —
// namespace objects don't survive the RSC client-reference boundary.
export { GoToRow };

/**
 * Mounts the global ⌘K palette.
 *
 * ⚠️ THE ACTIONS ARE DERIVED FROM THE NAV, NOT RE-DECLARED. This function used to hold a
 * hardcoded map of five destinations and look each nav href up in it — so any nav item it
 * had never heard of was silently dropped by a `.filter(Boolean)`, and by 2026-09-04 the
 * sidebar had items the palette did not offer (`/audit` Audit Log). Nobody broke it; the nav grew and the copy did not. Taking `NavItem[]`
 * whole means the palette cannot fall behind again, and a destination added to the sidebar
 * tomorrow appears here for free.
 *
 * `businesses` lets ⌘K do something useful at ORG level, where there is no entity search to
 * offer: the layout has already loaded them for the sidebar, so this costs no fetch.
 */
export function AppShellPalette({
  navItems,
  businesses,
}: {
  navItems: NavItem[];
  businesses: BizRef[];
}) {
  const actions: CommandAction[] = navItems.map((n) => ({
    id: `nav:${n.href}`,
    label: `Go to ${n.label}`,
    group: "Navigate",
    href: n.href,
    icon: <NavIcon name={n.icon} className="size-4" />,
    // The bare label too, so "metrics" matches as readily as "go to metrics".
    keywords: [n.label],
  }));
  return <CommandPalette actions={actions} businesses={businesses} />;
}
