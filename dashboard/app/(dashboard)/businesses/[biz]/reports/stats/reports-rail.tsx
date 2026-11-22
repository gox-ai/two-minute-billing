"use client";

import * as React from "react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { sentenceCase } from "@/lib/labels";
import type { ReportSummary } from "@/lib/api";
import {
  ABSENT_MODELS_LABEL,
  MODEL_GROUP_ORDER,
  modelSection,
  type ModelGroupId,
} from "@/lib/billing-models";

const ABSENT_ID = "__absent";

/**
 * Every report, by category, as one card beside the section. Categories fold; the one
 * holding the open report opens on arrival. Variants (ARR beside MRR) stay on the report's
 * own page rather than doubling the list.
 */
export function ReportsRail({
  biz,
  reports,
  models = null,
}: {
  biz: string;
  reports: ReportSummary[];
  /** The business's billing models; a report for a model it lacks folds under one heading. */
  models?: readonly string[] | null;
}) {
  // The `[key]` segment under `stats`; a route group (the library) matches no key.
  const active = useSelectedLayoutSegment();

  const groups = React.useMemo(() => {
    const by = new Map<
      string,
      { id: string; label: string; items: ReportSummary[]; order: number }
    >();
    const absent: ReportSummary[] = [];
    for (const r of reports) {
      const sec = modelSection(r.model, models);
      if (sec.absent) {
        absent.push(r);
        continue;
      }
      const order = MODEL_GROUP_ORDER.indexOf(sec.group as ModelGroupId);
      const g = by.get(r.category) ?? {
        id: r.category,
        label: r.category_label,
        items: [],
        order,
      };
      g.order = Math.min(g.order, order);
      g.items.push(r);
      by.set(r.category, g);
    }
    // A model the business has comes first; the engine's order holds inside a model.
    const present = [...by.values()].sort((a, b) => a.order - b.order);
    return absent.length > 0
      ? [...present, { id: ABSENT_ID, label: ABSENT_MODELS_LABEL, items: absent, order: 99 }]
      : present;
  }, [reports, models]);

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
                <span className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
                  {sentenceCase(g.label)}
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
                          title={sentenceCase(r.name)}
                          className={cn(
                            "block rounded-md px-2.5 py-1.5 text-sm",
                            isActive
                              ? "bg-muted font-semibold text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          {sentenceCase(r.name)}
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
