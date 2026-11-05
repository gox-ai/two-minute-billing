"use client";

import * as React from "react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReportSummary } from "@/lib/api";

/**
 * Every report, by category, as one card beside the section. Categories fold; the one
 * holding the open report opens on arrival. Variants (ARR beside MRR) stay on the report's
 * own page rather than doubling the list.
 */
export function ReportsRail({ biz, reports }: { biz: string; reports: ReportSummary[] }) {
  // The `[key]` segment under `stats`; a route group (the library) matches no key.
  const active = useSelectedLayoutSegment();

  const groups = React.useMemo(() => {
    const by = new Map<string, { id: string; label: string; items: ReportSummary[] }>();
    for (const r of reports) {
      const g = by.get(r.category) ?? { id: r.category, label: r.category_label, items: [] };
      g.items.push(r);
      by.set(r.category, g);
    }
    return [...by.values()];
  }, [reports]);

  const activeGroup = groups.find((g) => g.items.some((r) => r.key === active))?.id ?? null;
  const [open, setOpen] = React.useState<Set<string>>(
    () => new Set([activeGroup ?? groups[0]?.id].filter(Boolean) as string[]),
  );
  // Navigating to a report in a folded category opens it (adjusted during render).
  const [seen, setSeen] = React.useState(activeGroup);
  if (seen !== activeGroup) {
    setSeen(activeGroup);
    if (activeGroup && !open.has(activeGroup)) setOpen(new Set(open).add(activeGroup));
  }

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-label="Reports" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
        <h2 className="text-sm font-semibold">All reports</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{reports.length}</span>
      </div>
      <nav aria-label="Reports by category" className="flex flex-col gap-0.5 p-2">
        {groups.map((g) => {
          const expanded = open.has(g.id);
          const listId = `rail-${g.id}`;
          return (
            <div key={g.id}>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => toggle(g.id)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted/60"
              >
                <span className="min-w-0 flex-1 truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {g.label}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">{g.items.length}</span>
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    expanded && "rotate-180",
                  )}
                />
              </button>
              {expanded ? (
                <ul id={listId} className="flex flex-col">
                  {g.items.map((r) => {
                    const isActive = active === r.key;
                    return (
                      <li key={r.key}>
                        <Link
                          href={`/businesses/${biz}/reports/stats/${r.key}`}
                          aria-current={isActive ? "page" : undefined}
                          title={r.name}
                          className={cn(
                            "block truncate rounded-md px-2.5 py-1.5 text-sm",
                            isActive
                              ? "bg-muted font-semibold text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          {r.name}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>
    </section>
  );
}
