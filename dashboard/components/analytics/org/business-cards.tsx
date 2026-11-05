import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Building2, ChevronRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HEX_RE, onColor } from "@/lib/brand";
import { moneyCompact, pctFromBps } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RosterRow } from "@/components/analytics/org/business-roster";

/** Cards before the "all" card; with this many or fewer businesses, every one gets a card. */
const CARDS = 3;

/**
 * The way into a business, first thing on the organization page: the largest by MRR as cards,
 * one click into each Home, and the rest one jump away in the list below.
 */
export function BusinessCards({
  rows,
  currency,
  allHref,
}: {
  rows: RosterRow[];
  /** The reporting currency every MRR figure is stated in. */
  currency: string | null;
  allHref: string;
}) {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort(
    (a, z) => (z.mrrMinor ?? -1) - (a.mrrMinor ?? -1) || a.name.localeCompare(z.name),
  );
  const fitsAll = ordered.length <= CARDS + 1;
  const shown = fitsAll ? ordered : ordered.slice(0, CARDS);

  return (
    <section aria-label="Your businesses" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
        {shown.map((r, i) => (
          <BusinessCard key={r.id} row={r} currency={currency} lead={i === 0} />
        ))}
        {fitsAll ? null : (
          <Link href={allHref} className="group min-w-0">
            <Card className="hoverable flex h-full flex-col justify-center gap-1 border-primary/20 bg-primary/5 p-6 group-hover:border-primary/40">
              <span className="text-base font-semibold text-primary">
                All {rows.length} businesses
              </span>
              <span className="text-sm text-muted-foreground">
                {rows.length - shown.length} more
              </span>
            </Card>
          </Link>
        )}
      </div>
    </section>
  );
}

function BusinessCard({
  row,
  currency,
  lead,
}: {
  row: RosterRow;
  currency: string | null;
  /** The largest business states its MRR one step larger. */
  lead: boolean;
}) {
  const mrr = row.mrrMinor != null && row.mrrMinor > 0 && currency ? row.mrrMinor : null;
  const dunning = row.subscriptionsInDunning ?? 0;
  return (
    <Link href={`/businesses/${row.id}`} className="group min-w-0">
      <Card className="anim-rise hoverable relative flex h-full flex-col gap-3 overflow-hidden p-6 group-hover:border-primary/40">
        <BrandBand color={row.brandColor} />
        <div className="flex items-start gap-3">
          <BusinessMark row={row} />
          <span
            className="line-clamp-2 min-w-0 flex-1 text-base font-semibold wrap-break-word"
            title={row.name}
          >
            {row.name}
          </span>
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
            aria-hidden
          />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("font-semibold tabular-nums", lead ? "text-2xl" : "text-lg")}>
            {mrr != null ? moneyCompact(mrr, currency!) : "—"}
          </span>
          <span className="text-sm text-muted-foreground">
            {mrr != null
              ? `MRR${row.currency ? ` · bills in ${row.currency}` : ""}`
              : "No recurring revenue yet"}
          </span>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          {row.payingSubscriptions != null ? (
            <span>{row.payingSubscriptions.toLocaleString("en")} paying</span>
          ) : null}
          {row.changeBps != null && mrr != null ? (
            <span
              className={
                row.changeBps > 0
                  ? "text-success"
                  : row.changeBps < 0
                    ? "text-destructive"
                    : undefined
              }
            >
              {row.changeBps > 0 ? "+" : ""}
              {pctFromBps(row.changeBps, 1)} in 30 days
            </span>
          ) : null}
          {dunning > 0 ? (
            <span className="rounded-full bg-destructive-soft px-2 py-0.5 font-medium text-destructive">
              {dunning.toLocaleString("en")} in dunning
            </span>
          ) : null}
        </div>
      </Card>
    </Link>
  );
}

/** The business's brand as a 4px band on the card's top edge; nothing when it has none. */
function BrandBand({ color }: { color?: string | null }) {
  if (!color || !HEX_RE.test(color)) return null;
  return (
    <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: color }} />
  );
}

/** Its icon; else its initials on its brand colour; else our building mark. */
function BusinessMark({ row, size = "sm" }: { row: RosterRow; size?: "sm" | "lg" }) {
  const dim = size === "lg" ? "size-10" : "size-8";
  const box = cn(dim, size === "lg" ? "rounded-lg" : "rounded-md");
  if (row.iconUrl) {
    // Square: a mark often draws its own frame, and rounding clips its corners.
    // eslint-disable-next-line @next/next/no-img-element -- a tenant URL on any host
    return <img src={row.iconUrl} alt="" className={cn(dim, "shrink-0 object-contain")} />;
  }
  if (row.brandColor && HEX_RE.test(row.brandColor)) {
    return (
      <span
        aria-hidden
        className={cn(box, "flex shrink-0 items-center justify-center text-sm font-semibold")}
        style={{ backgroundColor: row.brandColor, color: onColor(row.brandColor) }}
      >
        {initials(row.name)}
      </span>
    );
  }
  return (
    <span className={cn(box, "flex shrink-0 items-center justify-center bg-primary/10")}>
      <Building2 className="size-4 text-primary" aria-hidden />
    </span>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The organization's only business, heading its own figures: with one business the
 * organization's totals ARE that business's, so its identity sits on them rather than
 * beside them. `children` are the figure cells.
 */
export function BusinessPanel({ row, children }: { row: RosterRow; children: ReactNode }) {
  return (
    <Card className="anim-rise relative gap-0 overflow-hidden p-0">
      <BrandBand color={row.brandColor} />
      <Link
        href={`/businesses/${row.id}`}
        className="group flex items-center gap-3.5 border-b px-6 py-4 hover:bg-muted/40"
      >
        <BusinessMark row={row} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-lg font-semibold wrap-break-word" title={row.name}>
            {row.name}
          </span>
          {row.currency ? (
            <span className="text-sm text-muted-foreground">Bills in {row.currency}</span>
          ) : null}
        </div>
        {/* The page's one way in, so it is drawn as the primary action. A span, not a
            Button: the whole row is already the link. */}
        <span className={cn(buttonVariants({ size: "sm" }), "group-hover:brightness-106")}>
          Open business
          <ArrowRight
            className="size-3.5 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </span>
      </Link>
      <div className="grid grid-cols-1 divide-y md:grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-y-0">
        {children}
      </div>
    </Card>
  );
}
