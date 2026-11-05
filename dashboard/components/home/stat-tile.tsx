import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * A single headline figure with a micro-label under it — the Dashboard archetype's
 * smallest unit (`ui` skill § 4b).
 *
 * Extracted because Overview and Metrics had each hand-rolled the identical markup
 * (`text-3xl … tabular-nums` over an uppercase `text-xs` label) three times between
 * them, which is how two tiles drift apart. `MetricCard` and `KpiStrip` next door
 * cannot serve this: both are typed to `BusinessAnalytics` and take a `biz`, so they
 * are unavailable to any org-scoped screen.
 *
 * The label is the uppercase micro-label from § 2 — it gets *tracking*, never a size
 * below the 12px floor.
 */
export function StatTile({
  value,
  label,
  hint,
  href,
  className,
}: {
  value: React.ReactNode;
  label: string;
  /** Optional supporting line under the label (a currency breakdown, an ARPU). */
  hint?: React.ReactNode;
  /** When set, the figure becomes a drill-down link. Accent colour = "this navigates". */
  href?: string;
  className?: string;
}) {
  const figure = <div className="text-3xl font-semibold tracking-tight tabular-nums">{value}</div>;

  return (
    <Card className={className}>
      <CardContent>
        {href ? (
          <Link href={href} className="text-primary hover:underline">
            {figure}
          </Link>
        ) : (
          figure
        )}
        <div className="mt-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        {hint ? <div className="mt-2 text-sm text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

/** Responsive row of tiles. `cols` is the widest breakpoint's column count. */
export function StatRow({
  cols = 3,
  className,
  children,
}: {
  cols?: 3 | 4 | 5;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-4 sm:grid-cols-3",
        cols === 4 && "lg:grid-cols-4",
        cols === 5 && "lg:grid-cols-5",
        className,
      )}
    >
      {children}
    </div>
  );
}
