"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BarChart3,
  Code2,
  Users,
  Settings,
  ScrollText,
  Sparkles,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  /** lucide icon key */
  icon: keyof typeof ICONS;
  /**
   * Unread count. Rendered as a badge, and as a DOT when the rail is collapsed — a number
   * inside a 4.25rem icon strip is unreadable, and the only thing the badge has to say there
   * is "something is waiting". Absent or 0 renders nothing.
   */
  badge?: number;
}

const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  metrics: BarChart3,
  developer: Code2,
  team: Users,
  settings: Settings,
  audit: ScrollText,
  releases: Sparkles,
  requests: Activity,
};

/**
 * Resolve a `NavItem`'s icon key to its lucide component — exported because the ⌘K palette
 * renders the same nav and must not keep a second key→icon map. `ICONS` stays private so
 * there is exactly one place a key is resolved; the fallback matches what the rail does, so
 * an unrecognised key degrades identically in both.
 */
export function NavIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? LayoutDashboard;
  return <Icon className={className} />;
}

/** Org-level sidebar nav (navy rail) with active-route highlighting. */
export function SideNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  // Overview owns the businesses tree too, so it stays lit when drilling in.
  const matches = (href: string) =>
    href === "/" ? path === "/" || path.startsWith("/businesses") : path.startsWith(href);
  // Only the most specific match lights: /developer/logs is not also "Developers".
  const activeHref = items
    .map((it) => it.href)
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  const isActive = (href: string) => href === activeHref;
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((it) => {
        const Icon = ICONS[it.icon] ?? LayoutDashboard;
        const active = isActive(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            title={it.label}
            aria-current={active ? "page" : undefined}
            // `nav-row` + a `nav-label` SPAN are what the collapsed rail styles against
            // (globals.css § app-rail): a bare text node cannot be hidden, so without the
            // span every org label stayed rendered and was simply clipped by the 4.25rem
            // width. `title` gives the icon-only row its name back, as BizSideNav does.
            className={cn(
              "nav-row relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            <Icon
              className={cn("size-4.5 shrink-0", active ? "text-sidebar-primary" : "opacity-80")}
            />
            <span className="nav-label">{it.label}</span>
            {it.badge ? <NavBadge count={it.badge} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The unread count, in its two registers.
 *
 * Expanded it is a number pushed to the row's end. Collapsed the rail is 4.25rem, so the
 * number is replaced by a dot pinned to the icon — `nav-label` on the digits is what hides
 * them, the same mechanism the row labels use, so there is one collapse rule and not two.
 *
 * A grey pill rather than a semantic tone: unread notes are news, not a state needing action,
 * and `--destructive` here would put an alarm colour on a changelog. The collapsed dot keeps
 * `--primary`, since a grey dot on an icon is invisible.
 */
export function NavBadge({
  count,
  tone = "news",
  label,
}: {
  count: number;
  /**
   * `news` (accent) vs `attention` (destructive). Exported and toned rather than copied,
   * because the business rail now badges work surfaces too — Retries is revenue at risk and
   * needs the alarm colour, while release notes must NOT have one. Same reasoning as the
   * original note below, applied in both directions.
   */
  tone?: "news" | "attention";
  /** Accessible name for the count. Defaults to the release-notes wording. */
  label?: string;
}) {
  return (
    // `nav-badge` is the hook the collapsed rail needs: `ml-auto` is what pushes the count
    // to the row's end when expanded, and an AUTO MARGIN absorbs all free space, which beats
    // the `justify-content: center` the collapsed row sets — so the icon was shoved left on
    // every badged row. The rail zeroes it; see globals.css § app-rail.
    <span
      className="nav-badge ml-auto flex shrink-0 items-center"
      aria-label={label ?? `${count} unread`}
    >
      {/* `nav-badge-count`, NOT `nav-label`. The label rule hides by pinning `width:1px`, and a
          padded pill has a 16px min-content floor that silently outranks it — the badge measured
          16px wide inside a 68px rail. The count and the dot get a symmetric display rule each. */}
      <span
        className={cn(
          "nav-badge-count min-w-5 rounded-full px-1.5 text-center text-xs font-medium tabular-nums",
          // `text-white` on destructive is the app's idiom (ui/button, ui/badge) — there is no
          // --destructive-foreground token. News is a quiet grey count; only attention is loud.
          tone === "attention" ? "bg-destructive text-white" : "bg-muted text-foreground/70",
        )}
      >
        {count > 99 ? "99+" : count}
      </span>
      {/* Shown only while the rail is collapsed — see globals.css § app-rail, which owns every
          collapse rule so there is one place to read them, including the dot's tone. */}
      <span className="nav-badge-dot" data-tone={tone} aria-hidden />
    </span>
  );
}
