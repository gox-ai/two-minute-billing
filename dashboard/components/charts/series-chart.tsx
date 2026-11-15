"use client";

import { AreaChart, type ChartPoint } from "@/components/charts/area-chart";
import { BucketBars } from "@/components/charts/bucket-bars";
import type { SeriesPolarity } from "@/components/analytics/series-format";

/**
 * A series drawn the way Home draws it: a FLOW (an amount per period) as one bar per bucket,
 * a stock or a rate as a line. Bars take the brand hue (`--chart-1`), the same as the lines,
 * or `--chart-4` when a rise is bad news (churn): red is kept for the involuntary share,
 * which only the cancellations report can split out.
 * Props stay serializable so a server component can render it.
 */
export function SeriesChart({
  data,
  flow,
  polarity = "neutral",
  kind,
  currency = "USD",
  seriesLabel,
  height = 220,
}: {
  data: ChartPoint[];
  /** The engine's own flow/stock declaration — never inferred from the numbers. */
  flow: boolean;
  polarity?: SeriesPolarity;
  kind: "money" | "count" | "percent";
  currency?: string;
  /** Names the bar in its tooltip. */
  seriesLabel: string;
  height?: number;
}) {
  if (!flow || kind === "percent") {
    return <AreaChart data={data} height={height} kind={kind} currency={currency} emphasizeLast />;
  }
  return (
    <BucketBars
      labels={data.map((d) => d.label)}
      values={data.map((d) => d.value)}
      seriesLabel={seriesLabel}
      tone={polarity === "up_bad" ? "soft" : "brand"}
      kind={kind}
      currency={currency}
      height={height}
      barMaxWidth={data.length <= 16 ? 32 : 18}
    />
  );
}
