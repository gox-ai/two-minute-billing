import { measureValueCompact } from "@/components/analytics/format";
import { CompareDelta } from "@/components/analytics/compare-delta";
import { measurePolarity } from "@/components/analytics/series-format";
import { TileFooter } from "@/components/analytics/tile-footer";
import type { AnalyticsResult } from "@/lib/analytics-api";

/**
 * One number and its direction — what a KPI card is for.
 *
 * 26px, not 32: a board draws many of these at once, and the 32px step is reserved for the ONE
 * figure a page is about.
 */
export function FigureTile({ result }: { result: AnalyticsResult }) {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="text-2xl font-semibold tabular-nums">
        {measureValueCompact(result.total, result.unit, result.currency)}
      </div>
      {result.compare ? (
        <CompareDelta compare={result.compare} polarity={measurePolarity(result.measure)} quiet />
      ) : null}
      <TileFooter result={result} />
    </div>
  );
}
