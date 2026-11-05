"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Building2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { NavBadge, SideNav, type NavItem } from "@/components/SideNav";
import {
  BIZ_NAV_SECTION_LABELS,
  businessNavEntries,
  isBizNavGroup,
  type BizNavSection,
  type BizNavEntry,
  type BizNavGroup,
} from "@/lib/business-nav";
import { useDashboardMode } from "@/components/mode-provider";
import { useNavCollapse } from "@/components/nav-collapse";

export interface BizPerms {
  manager: boolean;
  ops: boolean;
  admin: boolean;
}

export interface BizRef {
  id: string;
  name: string;
  /** The business's OWN mode. See `mode-provider.tsx`. */
  livemode: "live" | "test";
  /** On a test business: its live twin. Null on a standalone test business. */
  liveBusinessId?: string | null;
  /** On a live business: its test twin, once it exists. */
  testBusinessId?: string | null;
  /** The business's own square mark, shown in place of the building icon. */
  iconUrl?: string | null;
}

/** The business's icon where it has one; our building mark otherwise. */
export function BizMark({
  iconUrl,
  className,
  large = false,
}: {
  iconUrl?: string | null;
  className: string;
  /** The business header's mark: two lines tall, so a logo stays legible. */
  large?: boolean;
}) {
  if (!iconUrl) return <Building2 className={cn("size-4 shrink-0", className)} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host
    <img
      src={iconUrl}
      alt=""
      className={cn("shrink-0 object-contain", large ? "size-8" : "size-4")}
    />
  );
}

/**
 * Context-aware app navigation on the navy rail. At the org level it shows the
 * flat org nav; inside a business it swaps to the grouped business sidebar
 * (collapsible groups, Test-mode business chip).
 */
export function AppNav({
  orgItems,
  businesses,
  perms,
  bizCounts,
}: {
  orgItems: NavItem[];
  businesses: BizRef[];
  perms: BizPerms;
  /** Live counts for the viewed business's work surfaces; absent renders no badge. */
  bizCounts?: { retries?: number };
}) {
  const path = usePathname();
  const mode = useDashboardMode();
  const match = path.match(/^\/businesses\/([^/]+)/);
  const biz = match?.[1];
  if (!biz) {
    return <OrgSideNav items={orgItems} businesses={businesses} />;
  }
  // The business's own mode, resolved once by the provider. Time Travel below is gated on it.
  const testMode = mode?.mode === "test";
  return <BizSideNav biz={biz} perms={perms} testMode={testMode} counts={bizCounts} />;
}

/** How many businesses the org rail lists before handing over to the full roster. */
const RAIL_BUSINESSES = 8;

/**
 * The org rail, plus the live businesses — one click into any of them (test mode is a
 * switch inside each one).
 * Reaching a business used to mean finding it in the Overview roster; the rail is where
 * people look for a destination. Capped, with the roster one link away for the rest.
 *
 * Hidden on the collapsed rail: a column of identical building icons names nothing.
 */
function OrgSideNav({ items, businesses }: { items: NavItem[]; businesses: BizRef[] }) {
  const inMode = businesses
    .filter((b) => b.livemode === "live")
    .sort((a, z) => a.name.localeCompare(z.name));
  const shown = inMode.slice(0, RAIL_BUSINESSES);
  return (
    <div className="flex flex-col gap-5">
      <SideNav items={items} />
      {shown.length > 0 ? (
        <nav aria-label="Businesses" data-collapse="hide" className="flex flex-col gap-0.5">
          <span className="px-2.5 pb-1 text-xs text-muted-foreground">Businesses</span>
          {shown.map((b) => (
            <Link
              key={b.id}
              href={`/businesses/${b.id}`}
              title={b.name}
              className="nav-row flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            >
              <BizMark iconUrl={b.iconUrl} className="opacity-80" />
              <span className="nav-label truncate">{b.name}</span>
            </Link>
          ))}
          {inMode.length > shown.length ? (
            <Link
              href="/"
              className="px-2.5 py-1.5 text-xs font-medium text-primary hover:underline"
            >
              All {inMode.length} businesses →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

/**
 * The entries themselves now live in `@/lib/business-nav`, because the ⌘K palette needs the
 * same list to offer these pages as jump targets. Keeping a second copy here is what let the
 * palette drift three org items behind this sidebar and miss every business page entirely.
 */
type Group = BizNavGroup;

/**
 * A group of two (Invoices & Credit Notes) costs a click to reveal two rows that fit anyway, so
 * it renders as those two rows, each under the group's icon. Larger groups stay folded.
 */
function inlineSmallGroup(e: BizNavEntry): BizNavEntry[] {
  if (!isBizNavGroup(e)) return [e];
  const kids = e.children.filter((c) => c.show);
  if (kids.length > 2) return [e];
  return kids.map((c) => ({ ...c, icon: c.icon ?? e.icon, section: e.section, show: e.show }));
}
type Entry = BizNavEntry;
const isGroup = isBizNavGroup;

function BizSideNav({
  biz,
  perms,
  testMode,
  counts,
}: {
  biz: string;
  perms: BizPerms;
  testMode: boolean;
  counts?: { retries?: number };
}) {
  const path = usePathname();
  const entries: Entry[] = businessNavEntries({ biz, perms, testMode, counts });
  // Consecutive visible entries sharing a section; a section with nothing visible drops out.
  const sections: Array<{ section?: BizNavSection; items: Entry[] }> = [];
  for (const e of entries.filter((x) => x.show)) {
    const last = sections.at(-1);
    if (last && last.section === e.section) last.items.push(e);
    else sections.push({ section: e.section, items: [e] });
  }

  const activeLeaf = (leaf: { href: string; exact?: boolean }) =>
    leaf.exact ? path === leaf.href : path === leaf.href || path.startsWith(leaf.href + "/");

  return (
    <div className="flex flex-col gap-3">
      {/* Rows keep the org rail's rhythm (`SideNav`: gap-0.5 + py-2); sections are
          spaced like the org rail's Businesses block (gap-4/5) rather than divided. */}
      <nav className="flex flex-col gap-4">
        {sections.map(({ section, items }) => (
          <div key={section ?? "top"} className="flex flex-col gap-0.5">
            {section ? (
              // Hidden on the collapsed rail; the section gap still separates the icons.
              <span data-collapse="hide" className="px-2.5 pb-1 text-xs text-muted-foreground">
                {BIZ_NAV_SECTION_LABELS[section]}
              </span>
            ) : null}
            {items.flatMap(inlineSmallGroup).map((e) =>
              isGroup(e) ? (
                <CollapsibleGroup
                  key={e.label}
                  group={e}
                  anyChildActive={e.children.some((c) => activeLeaf(c))}
                >
                  {e.children
                    .filter((c) => c.show)
                    .map((c) => (
                      <NavLink
                        key={c.href}
                        href={c.href}
                        label={c.label}
                        active={activeLeaf(c)}
                        nested
                      />
                    ))}
                </CollapsibleGroup>
              ) : (
                <NavLink
                  key={e.href}
                  href={e.href}
                  label={e.label}
                  icon={e.icon}
                  active={activeLeaf(e)}
                  badge={e.badge}
                  badgeTone={e.badgeTone}
                />
              ),
            )}
          </div>
        ))}
      </nav>
    </div>
  );
}

function CollapsibleGroup({
  group,
  anyChildActive,
  children,
}: {
  group: Group;
  anyChildActive: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpenState] = React.useState(anyChildActive);
  const key = `tmb:nav-group:${group.label}`;
  // A group you opened stays open on the next page and the next visit. Read after mount so the
  // server and first client render agree; blocked storage just means it is not remembered.
  React.useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(key);
    } catch {
      /* blocked storage */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (anyChildActive || stored === "1") setOpenState(true);
  }, [anyChildActive, key]);
  const setOpen = (next: boolean | ((o: boolean) => boolean)) => {
    setOpenState((o) => {
      const v = typeof next === "function" ? next(o) : next;
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* blocked storage */
      }
      return v;
    });
  };
  const { collapsed, setCollapsed } = useNavCollapse();
  const Icon = group.icon;
  return (
    // `gap-0.5` matches the nav's own: without it the group header sat flush against
    // its first child while every other pair had 2px, so an open group read as one
    // 74px block rather than two rows.
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        // On a collapsed rail this reads as "expanded/collapsed group" while the
        // group's children are not rendered at all, which is a lie to a screen
        // reader. Collapsed, the control is a rail opener and says so.
        aria-expanded={collapsed ? undefined : open}
        title={group.label}
        onClick={() => {
          /**
           * Collapsed, the children have no icons and so cannot be shown — but the
           * pages behind them must stay reachable. Pressing the group opens the RAIL
           * and the group together, which is one press to the same place rather than
           * a flyout menu that would need its own focus trap and hover timing.
           */
          if (collapsed) {
            setCollapsed(false);
            setOpen(true);
            return;
          }
          setOpen((o) => !o);
        }}
        className="nav-row flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      >
        <Icon className="size-4.5 shrink-0 opacity-80" />
        <span className="nav-label">{group.label}</span>
        <ChevronDown
          data-collapse="hide"
          className={cn("ms-auto size-3.5 transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open ? <div className="flex flex-col gap-0.5">{children}</div> : null}
    </div>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  nested,
  badge,
  badgeTone,
}: {
  href: string;
  label: string;
  icon?: LucideIcon;
  active: boolean;
  nested?: boolean;
  badge?: number;
  badgeTone?: "attention" | "news";
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      // A NESTED item has no icon by design, so it has nothing to show on a
      // collapsed rail — it hides, and its group's icon still reaches it.
      data-collapse={nested ? "hide" : undefined}
      title={label}
      className={cn(
        // `relative` is load-bearing, not tidiness: the collapsed rail's badge DOT is
        // `position: absolute`, so without a positioned ancestor here it would anchor to the
        // scroll container and sit somewhere else entirely. `SideNav`'s row already has it.
        "nav-row relative flex h-9 items-center gap-2.5 rounded-lg text-sm transition-colors",
        nested ? "pr-2.5 pl-10" : "px-2.5",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      {Icon && !nested ? (
        <Icon className={cn("size-4.5 shrink-0", active ? "text-sidebar-primary" : "opacity-80")} />
      ) : null}
      {/* Wrapped so the collapsed rail can hide it WITHOUT taking the link's
          accessible name with it — see the rail block in globals.css. */}
      <span className="nav-label">{label}</span>
      {badge ? (
        <NavBadge count={badge} tone={badgeTone} label={`${badge} ${label} needing attention`} />
      ) : null}
    </Link>
  );
}
