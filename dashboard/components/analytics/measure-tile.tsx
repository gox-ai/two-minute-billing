import { roleOfResult } from "@/components/analytics/role";
import { FigureTile } from "@/components/analytics/figure-tile";
import { TrendTile } from "@/components/analytics/trend-tile";
import { SliceTable } from "@/components/analytics/slice-table";
import { TileFooter } from "@/components/analytics/tile-footer";
import type { AnalyticsResult } from "@/lib/analytics-api";

export { roleOfResult, HERO_MIN_SPAN } from "@/components/analytics/role";

/**
 * One measure answer, rendered as whichever of the four shapes it actually is.
 * The composer for any screen that shows a semantic-layer result — a board tile,
 * a single-measure card — so a shape decision made once here does not have to be
 * re-litigated per screen.
 */
export function MeasureTile({ result, biz }: { result: AnalyticsResult; biz: string }) {
  const role = roleOfResult(result);
  if (role === "figure") return <FigureTile result={result} />;
  if (role === "trend") return <TrendTile result={result} />;
  return (
    <div className="flex h-full flex-col gap-3">
      <SliceTable result={result} biz={biz} />
      <TileFooter result={result} />
    </div>
  );
}
