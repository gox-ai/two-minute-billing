import * as React from "react";
import { Card } from "@/components/ui/card";
import { KPI_LABEL, spanClass, type Span } from "@/components/analytics/layout";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/analytics/info-tip";
import type { CardInfo } from "@/components/analytics/card-info";

/**
 * One figure: what it counts, the number, and the sentence that keeps it honest.
 *
 * `note` is not decoration. Every figure on this screen is qualified by something — the
 * instant it was taken, the population it divides by, the fact that its unit will not
 * divide into the figure beside it — and a number quoted without that qualification is the
 * one that gets misread into a decision.
 *
 * Nothing here carries semantic colour. A failed charge that is still being retried needs
 * a human and earns a fill, but it earns it on the ROW that names the invoice, not on a
 * summary tile that nobody can act on.
 */
export function RecoveryFigure({
  label,
  value,
  note,
  info,
  span,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  info?: CardInfo;
  span: Span;
}) {
  return (
    <Card className={cn("anim-rise flex min-w-0 flex-col gap-0 p-6", spanClass(span))}>
      <span className="flex items-center gap-1">
        <span className={KPI_LABEL}>{label}</span>
        {info ? <InfoTip label={label} info={info} /> : null}
      </span>
      <span className="mt-2 text-2xl font-semibold tabular-nums">{value}</span>
      {note ? <span className="mt-1 text-xs text-muted-foreground">{note}</span> : null}
    </Card>
  );
}
