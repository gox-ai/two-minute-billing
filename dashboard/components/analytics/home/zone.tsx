import * as React from "react";

const ZONES = {
  businesses: { label: "Businesses" },
  portfolio: { label: "Portfolio" },
  current: { label: "Current" },
  performance: { label: "Performance" },
} as const;

/**
 * The heading over one of Home's zones: "Current" holds readings as they stand, and
 * "Performance" everything the period drives. It states the instant or the window once, so
 * the cards under it carry no per-card chip. The organization home adds "Businesses" (the
 * way in) and "Portfolio" (their combined figures), so the two rows of cards don't run together.
 */
export function ZoneHeading({
  zone,
  children,
}: {
  zone: keyof typeof ZONES;
  /** The as-at instant, or the period picker and its resolved range. */
  children?: React.ReactNode;
}) {
  const { label } = ZONES[zone];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="text-xl font-medium tracking-[-0.01em]">{label}</h2>
      {children}
    </div>
  );
}

/** Secondary text beside a zone title: an instant or a window. */
export function ZoneMeta({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground tabular-nums">{children}</span>;
}
