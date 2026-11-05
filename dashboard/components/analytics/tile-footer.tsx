import { CoverageNote } from "@/components/analytics/coverage-note";
import type { AnalyticsResult } from "@/lib/analytics-api";

/**
 * Everything a tile owes the reader that is not the answer itself — what history it is
 * missing, what a segment's membership means — gathered under the answer rather than
 * stacked above it. Each line is still the engine's own words. How fresh the figures are is
 * the page's "Synced" badge: `computed_at` is the OLDEST row in the range, so a year of
 * closed history read as days stale while today's figure was minutes old.
 */
export function TileFooter({ result }: { result: AnalyticsResult }) {
  if (!result.coverage && !result.segment) return null;
  return (
    <div className="mt-auto space-y-1 pt-2">
      {result.segment ? (
        <p className="text-xs text-muted-foreground">{result.segment.note}</p>
      ) : null}
      <CoverageNote coverage={result.coverage} compact />
    </div>
  );
}
