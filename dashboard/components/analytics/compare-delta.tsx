import { DeltaChip } from "@/components/analytics/delta-chip";
import { pctFromBps } from "@/lib/format";
import type { AnalyticsResult } from "@/lib/analytics-api";
import type { SeriesPolarity } from "@/components/analytics/series-format";
import { localYmd, rangeLabel } from "@/components/analytics/home/parts";

/**
 * The delta the engine computed, plus the window it compared against — never recomputed
 * here. The dates are named, because "previous period" alone leaves the reader guessing.
 */
const BASIS_LABEL: Record<
  NonNullable<AnalyticsResult["compare"]>["basis"],
  (c: NonNullable<AnalyticsResult["compare"]>) => string
> = {
  previous_window: (c) => `vs ${rangeLabel(localYmd(c.start, null), localYmd(c.end, null))}`,
};

/**
 * With a `polarity`, tone is direction × polarity — a rise in churn is bad news and renders as
 * such. Without one, tone follows the sign, which is only right for figures where more is
 * better; pass the polarity wherever the measure is known.
 */
export function CompareDelta({
  compare,
  polarity,
  quiet = false,
}: {
  compare: NonNullable<AnalyticsResult["compare"]>;
  polarity?: SeriesPolarity;
  /**
   * Render nothing when there is no base to compare against. On a board every tile would
   * otherwise carry the same "no comparable base" line; an absent chip makes no claim.
   */
  quiet?: boolean;
}) {
  const bps = compare.change_bps;
  if (quiet && bps == null) return null;
  const down = bps != null && bps < 0;
  const good =
    polarity == null
      ? !down
      : polarity === "neutral"
        ? null
        : polarity === "up_good"
          ? !down
          : down;
  const tone = good == null || bps === 0 ? "neutral" : good ? "good" : "bad";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Flat is an answer too: in quiet mode a zero change still gets its (neutral) chip,
          rather than leaving a bare "vs <dates>" that reads like missing data. */}
      {bps != null && (bps !== 0 || quiet) ? (
        <DeltaChip direction={bps === 0 ? "flat" : bps < 0 ? "down" : "up"} tone={tone}>
          {pctFromBps(Math.abs(bps))}
        </DeltaChip>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {bps == null ? "No comparable base · " : ""}
        {BASIS_LABEL[compare.basis](compare)}
      </span>
    </div>
  );
}
