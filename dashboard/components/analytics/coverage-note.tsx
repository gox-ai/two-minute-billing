import { TriangleAlert } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import type { AnalyticsResult } from "@/lib/analytics-api";

/**
 * The engine's own sentence about a partial history, shown VERBATIM. This is the only
 * thing standing between a reader and a flattering pre-cutover figure — a missing
 * period is unknown, not zero, and the note is what says so. `warning`, not `error`:
 * the answer is still correct, it is just partial.
 *
 * `compact` is for a board tile: the same sentence as one muted line under the figure.
 * A boxed alert on a small card reads as a failure and pushes the chart out of sight,
 * while the words — which are what carry the caveat — are unchanged.
 */
export function CoverageNote({
  coverage,
  compact = false,
}: {
  coverage?: AnalyticsResult["coverage"];
  compact?: boolean;
}) {
  if (!coverage) return null;
  if (compact) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        <span>{coverage.note}</span>
      </p>
    );
  }
  return (
    <Alert tone="warning" className="text-xs">
      {coverage.note}
    </Alert>
  );
}
