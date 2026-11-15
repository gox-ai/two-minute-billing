"use client";
import * as React from "react";
import Link from "next/link";
import { LinkPending } from "@/components/route-motion";
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
import { RAIL_PILL } from "@/lib/motion";
import { NAV_FOCUS, RailTip } from "@/components/rail-tip";

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
    <nav className="relative isolate flex flex-col gap-0.5">
      {RAIL_PILL ? <RailPill /> : null}
      {items.map((it) => {
        const Icon = ICONS[it.icon] ?? LayoutDashboard;
        const active = isActive(it.href);
        return (
          <RailTip key={it.href} label={it.label}>
            <Link
              href={it.href}
              data-nav-label={it.label}
              aria-current={active ? "page" : undefined}
              // `nav-row` + a `nav-label` SPAN are what the collapsed rail styles against
              // (globals.css § app-rail): a bare text node cannot be hidden, so without the
              // span every org label stayed rendered and was simply clipped by the 4.25rem
              // width. `title` gives the icon-only row its name back, as BizSideNav does.
              className={cn(
                NAV_FOCUS,
                "nav-row relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <Icon
                className={cn("size-4 shrink-0", active ? "text-sidebar-primary" : "opacity-80")}
              />
              <span className="nav-label">{it.label}</span>
              {it.badge ? <NavBadge count={it.badge} /> : null}
              <LinkPending />
            </Link>
          </RailTip>
        );
      })}
    </nav>
  );
}

type Box = { x: number; y: number; w: number; h: number };
const ACTIVE_ROW = '.nav-row[aria-current="page"]';
const READY = "data-rail-pill-ready";

/**
 * The rail's selected-row highlight, as ONE element that slides to the new row.
 *
 * Render it as the first child of a `relative isolate` nav list. It finds the
 * `aria-current="page"` row at any depth (sections, open groups), measures it in layout
 * space, and slides only when the selected row CHANGES; a resize, a rail collapse or a
 * group opening above it moves it at once, as the rows themselves move. No visible
 * selected row (a closed group, the collapsed rail hiding nested rows): the pill hides.
 * Until it has measured, the row paints its own background (server HTML and first paint
 * match); then the list gets `data-rail-pill-ready` and app/motion/rail-pill.css hands over.
 */
export function RailPill() {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [pill, setPill] = React.useState<{ box: Box; glide: boolean } | null>(null);

  React.useLayoutEffect(() => {
    const list = ref.current?.parentElement;
    if (!list) return;
    let last: Element | null = null;

    const measure = () => {
      const active = list.querySelector<HTMLElement>(ACTIVE_ROW);
      const l = list.getBoundingClientRect();
      const r = active?.getBoundingClientRect();
      if (!active || !r || r.width === 0 || l.width === 0) {
        list.removeAttribute(READY);
        last = null;
        setPill(null);
        return;
      }
      // Divide out any ancestor scale, as SegmentIndicator does.
      const k = l.width / (Number.parseFloat(getComputedStyle(list).width) || l.width);
      const box = {
        x: (r.left - l.left) / k - list.clientLeft,
        y: (r.top - l.top) / k - list.clientTop,
        w: r.width / k,
        h: r.height / k,
      };
      const glide = last !== null && active !== last;
      last = active;
      // An unchanged box keeps its state, so a running slide is never cut short.
      setPill((p) =>
        p && p.box.x === box.x && p.box.y === box.y && p.box.w === box.w && p.box.h === box.h
          ? p
          : { box, glide },
      );
      list.setAttribute(READY, "");
    };

    measure();
    const ro = new ResizeObserver(measure);
    const observeAll = () => {
      ro.disconnect();
      ro.observe(list);
      for (const row of list.querySelectorAll(".nav-row")) ro.observe(row);
    };
    observeAll();
    // Navigation moves `aria-current`; opening or closing a group mounts or drops rows.
    const mo = new MutationObserver((records) => {
      if (records.some((rec) => rec.type === "childList")) observeAll();
      measure();
    });
    mo.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-current"],
    });
    return () => {
      ro.disconnect();
      mo.disconnect();
      list.removeAttribute(READY);
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="rail-pill"
      data-glide={pill?.glide || undefined}
      className={cn(
        "rail-pill pointer-events-none absolute top-0 left-0 -z-10 rounded-md bg-sidebar-accent",
        !pill && "invisible",
      )}
      style={
        pill
          ? {
              transform: `translate(${pill.box.x}px, ${pill.box.y}px)`,
              width: pill.box.w,
              height: pill.box.h,
            }
          : undefined
      }
    />
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
