import * as React from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TimelineEntry {
  label: string;
  date: React.ReactNode;
}

/** Timeline block (Created on / Started on / Next billing on …). */
export function TimelineCard({
  entries,
  className,
}: {
  entries: Array<TimelineEntry | null | undefined | false>;
  className?: string;
}) {
  const items = entries.filter(Boolean) as TimelineEntry[];
  if (items.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Clock className="size-4 text-muted-foreground" aria-hidden />
        Timeline
      </h3>
      <ul className="space-y-1.5 text-sm">
        {items.map((e, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span
              className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden
            />
            <span className="text-muted-foreground">{e.label}</span>
            <span className="font-medium">{e.date}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
