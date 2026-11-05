"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface TabRailItem {
  id: string; // anchor target (SectionCard id)
  label: string;
}

/**
 * Left anchor rail on detail pages: bulleted section links
 * that scroll to SectionCards. Highlights the section in view (scroll-spy).
 */
export function TabRail({ items, className }: { items: TabRailItem[]; className?: string }) {
  const [active, setActive] = React.useState(items[0]?.id);

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const item of items) {
      const el = document.getElementById(item.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  // `xl:block`, not `lg:block`: at lg the detail layout is still one column, so a
  // fixed-width table of contents became a stacked list of anchors sitting above
  // the very sections it links to. It now returns with the rest of the desktop
  // three-column layout, at the same breakpoint the rails do.
  return (
    <nav
      aria-label="Sections"
      className={cn("sticky top-20 hidden w-44 shrink-0 self-start xl:block", className)}
    >
      <ul className="space-y-1 text-xs">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              onClick={() => setActive(item.id)}
              className={cn(
                "flex items-center gap-2 rounded px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground",
                active === item.id && "bg-muted/30 font-bold text-foreground",
              )}
            >
              <span
                className={cn(
                  "size-1 rounded-full bg-muted-foreground/40",
                  active === item.id && "bg-primary",
                )}
                aria-hidden
              />
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
