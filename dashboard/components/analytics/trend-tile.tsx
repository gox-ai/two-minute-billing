"use client";

import { SeriesChart } from "@/components/charts/series-chart";
import { measureValueCompact, chartKindFor } from "@/components/analytics/format";
import { CompareDelta } from "@/components/analytics/compare-delta";
import { measurePolarity, stockPoints } from "@/components/analytics/series-format";
import { TileFooter } from "@/components/analytics/tile-footer";
import type { AnalyticsResult } from "@/lib/analytics-api";

/**
 * A value over time: the figure and its direction first, then the series that explains it,
 * then the housekeeping. The chart sits directly under the number it draws, so the eye goes
 * figure → shape without crossing a warning box on the way.
 */
export function TrendTile({ result, height = 200 }: { result: AnalyticsResult; height?: number }) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="space-y-1.5">
        <div className="text-2xl font-semibold tabular-nums">
          {measureValueCompact(result.total, result.unit, result.currency)}
        </div>
        {result.compare ? (
          <CompareDelta compare={result.compare} polarity={measurePolarity(result.measure)} quiet />
        ) : null}
      </div>
      <SeriesChart
        data={stockPoints(result)}
        flow={result.kind === "flow" && result.unit !== "ratio"}
        polarity={measurePolarity(result.measure)}
        seriesLabel={result.name}
        height={height}
        kind={chartKindFor(result.unit)}
        currency={result.currency ?? "USD"}
      />
      <TileFooter result={result} />
    </div>
  );
}
