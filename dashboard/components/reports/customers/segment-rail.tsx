import { PendingLink } from "@/components/reports/pending-link";
import { RecordCard } from "@/components/patterns/record-page";
import { cn } from "@/lib/utils";
import type { Segment } from "@/lib/api/segments";

// Below xl the rail is a wrapped row of pills, so it costs a few lines above the table.
const GROUP =
  "self-center px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase xl:self-auto xl:px-3 xl:pt-2.5 xl:pb-1";
const PILL = "rounded-full border px-3 py-1 xl:rounded-md xl:border-0 xl:py-1.5";

/**
 * The saved-segment rail.
 *
 * ⚠️ These are SEGMENTS, not views. A saved list view lives in the `All customers ▾`
 * dropdown on the customers LIST and narrows that screen; a segment names a population
 * and is what the reports compare a metric across. The rail never uses the word "view",
 * and the customers list's own dropdown never uses the word "segment".
 *
 * A server component: the current entry is decided from the URL the server already has. Each
 * entry is a `PendingLink`, so a switch shows the page's loading state.
 */
export function SegmentRail({
  biz,
  segments,
  current,
  custom,
}: {
  biz: string;
  segments: Segment[];
  /** The selected segment's id, or null for "All customers". */
  current: string | null;
  /** True when the chips no longer match any saved segment. */
  custom: boolean;
}) {
  const base = `/businesses/${biz}/reports/customers`;
  const starters = segments.filter((s) => s.is_starter);
  const saved = segments.filter((s) => !s.is_starter);

  const entry = (href: string, label: string, active: boolean, title?: string) => (
    <PendingLink
      key={href + label}
      href={href}
      source="segment"
      scroll
      title={title}
      aria-current={active ? "page" : undefined}
      className={cn(
        "block text-sm text-muted-foreground",
        PILL,
        "hover:bg-muted hover:text-foreground hover:no-underline",
        active && "bg-muted font-semibold text-foreground",
      )}
    >
      {label}
    </PendingLink>
  );

  const meta = [
    `${starters.length.toLocaleString("en")} ${starters.length === 1 ? "starter" : "starters"}`,
    saved.length > 0 ? `${saved.length.toLocaleString("en")} saved` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <RecordCard title="Segments" meta={meta} flush>
      <nav
        aria-label="Saved segments"
        className="flex flex-wrap gap-1.5 p-3 xl:flex-col xl:flex-nowrap xl:gap-px xl:px-2 xl:pt-2 xl:pb-3"
      >
        {entry(base, "All customers", current === null && !custom)}
        {starters.length > 0 ? <div className={GROUP}>Ships with the product</div> : null}
        {starters.map((s) =>
          entry(`${base}?segment=${s.id}`, s.name, current === s.id, s.description ?? undefined),
        )}
        {saved.length > 0 ? <div className={GROUP}>Saved by your team</div> : null}
        {saved.map((s) =>
          entry(`${base}?segment=${s.id}`, s.name, current === s.id, s.description ?? undefined),
        )}
        {/*
          No "Manage segments" link: there is no manage screen. A segment is created from
          the chips on this page, so a link would open nothing.
        */}
        {custom ? (
          <>
            <div className="my-2 hidden h-px bg-border xl:block" />
            <span
              aria-current="page"
              className={cn("block bg-muted text-sm font-semibold text-foreground", PILL)}
            >
              Custom filter
            </span>
          </>
        ) : null}
      </nav>
    </RecordCard>
  );
}
