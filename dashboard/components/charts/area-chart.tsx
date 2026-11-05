"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { useThemeStamp } from "@/components/charts/theme-stamp";
import { EChart } from "@/components/charts/echart";
import { money, countCompact, pctFromBps, toMajor } from "@/lib/format";

/** A point may have NO value: an unmeasured period is a gap, never a zero. */
export interface ChartPoint {
  label: string;
  value: number | null;
}

/**
 * The line follows `--chart-1`, so the chart is the same brand hue as the rest of the
 * theme and changes with it. It used to be a hardcoded blue used in
 * BOTH themes, and a second copy of that literal lived in `metric-card` for the
 * legend swatch — which is exactly how the previous palette drifted.
 *
 * ECharts paints to SVG and cannot read a CSS variable, so the value is resolved
 * from the document after mount; `useThemeStamp` is the dependency that re-reads
 * it on a light/dark switch. SSR renders with the light value, which is what the
 * light theme resolves to anyway.
 */
export const CHART_LINE_FALLBACK = "#4e4eda";
const CHART_LINE_FALLBACK_DARK = "#8b8bf2";
/*
  Fallbacks only. The real values are READ FROM THE THEME below: these two were hardcoded,
  so the axis ink stayed the same grey in both themes while everything around it moved —
  the one place in the chart that did not follow the tokens.
*/
const GRID_FALLBACK = "rgba(128,128,128,0.18)";
const LABEL_FALLBACK = "#9ca3af";
/** What a period with no stored figure reads as — in the tooltip, and nowhere else. */
const NO_FIGURE = "no figure";

/**
 * The axis ink — gridlines and tick labels — resolved from the theme, the same way and for
 * the same reason as `useChartLine`. ECharts paints to SVG and cannot read a CSS variable.
 */
export function useChartInk() {
  const { resolvedTheme } = useTheme();
  const stamp = useThemeStamp();
  return React.useMemo(() => {
    if (typeof document === "undefined") return { grid: GRID_FALLBACK, label: LABEL_FALLBACK };
    const read = (v: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return {
      grid: read("--border") || GRID_FALLBACK,
      label: read("--muted-foreground") || LABEL_FALLBACK,
    };
    // `stamp` re-reads once the new theme is on <html> (see theme-stamp).
  }, [resolvedTheme, stamp]);
}

export function useChartLine() {
  const { resolvedTheme } = useTheme();
  const stamp = useThemeStamp();
  // Read during render, not from an effect. Safe on both counts: on the server
  // there is no document, and on the client the colour never reaches the server
  // HTML — `EChart` inits the chart in an effect, so nothing here can mismatch
  // on hydration. Reading it in an effect would need setState and a second pass.
  return React.useMemo(() => {
    if (typeof document === "undefined") return CHART_LINE_FALLBACK;
    const v = getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim();
    // The fallback is theme-aware too: if the property cannot be read at all,
    // a light-theme line on a dark card is worse than no chart.
    return v || (resolvedTheme === "dark" ? CHART_LINE_FALLBACK_DARK : CHART_LINE_FALLBACK);
  }, [resolvedTheme, stamp]);
}

/** `#rrggbb` → `rgba(r,g,b,a)`; the area wash is the line at low opacity. */
export function washOf(hex: string, alpha: number) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Filled line/area chart (ECharts) — the metrics-dashboard staple. Props stay
 * serializable (no function props) so a server component can render it directly:
 * pass `kind="money"` + `currency` for money series, `percent` for basis points,
 * else counts.
 *
 * Axis labels are compact (`3k`, `$49.6k`); tooltips carry the full value.
 * `emphasizeLast` puts a dot on the newest point.
 */
export function AreaChart({
  data,
  height = 220,
  kind = "count",
  currency = "USD",
  emphasizeLast = false,
  labelInterval,
  fitRange = false,
  fill = false,
}: {
  /** Grow to the parent's height (see `EChart`); `height` becomes the floor. */
  fill?: boolean;
  /** Fit the y-axis to the data instead of starting it at zero. */
  fitRange?: boolean;
  data: ChartPoint[];
  height?: number;
  kind?: "money" | "count" | "percent";
  currency?: string;
  emphasizeLast?: boolean;
  /** Show every Nth x-axis label (ECharts `interval`); default = auto-hide overlaps. */
  labelInterval?: number;
}) {
  // A gap reads as a gap. ECharts hands a null point through as a non-finite value, and
  // `Math.round` turned that into NaN — a tooltip saying "$NaN" over a period the engine
  // deliberately answered `null` for, directly under a note saying the period is unknown
  // rather than zero.
  const full = React.useCallback(
    (n: number) => {
      if (!Number.isFinite(n)) return NO_FIGURE;
      if (kind === "money") return money(Math.round(n), currency);
      if (kind === "percent") return pctFromBps(Math.round(n));
      return Math.round(n).toLocaleString("en");
    },
    [kind, currency],
  );
  // Axis labels are bare compact numbers (`210k`) — the headline above the
  // chart already states the currency.
  const axis = React.useCallback(
    (n: number) => {
      if (!Number.isFinite(n)) return "";
      // `toMajor`, not `/ 100`: the divisor is the CURRENCY's exponent. A hardcoded 100
      // made a JPY axis read 100x low (JPY has no minor unit) and a KWD axis 10x high.
      // Survived the 2026-08-01 minor-units sweep because that pass hunted INPUTS and
      // this is a display-only formatter.
      if (kind === "money") return countCompact(toMajor(Math.round(n), currency));
      if (kind === "percent") return pctFromBps(Math.round(n), 1);
      return countCompact(n);
    },
    [kind, currency],
  );
  const LINE = useChartLine();
  const { grid: GRID, label: LABEL } = useChartInk();
  const lastMeasured = React.useMemo(() => {
    const measured = data
      .map((d, index) => ({ index, value: d.value }))
      .filter(
        (p): p is { index: number; value: number } => p.value != null && Number.isFinite(p.value),
      );
    return measured[measured.length - 1] ?? null;
  }, [data]);
  const option = React.useMemo(
    () => ({
      // Room to breathe: the chart is the centrepiece of a metric page, and a plot pressed
      // against its own labels reads as a thumbnail.
      grid: { left: 56, right: 16, top: 20, bottom: 28 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => full(v) },
      xAxis: {
        type: "category",
        data: data.map((d) => d.label),
        boundaryGap: false,
        axisTick: { show: false },
        // No rule under the plot. The gridlines already carry the scale, and a baseline
        // heavy enough to see competes with the series sitting on it.
        axisLine: { show: false },
        axisLabel:
          labelInterval != null
            ? // `interval` picks which labels are CANDIDATES; `hideOverlap` then drops the ones
              // that still collide. A caller asking for every Nth label is stating a preference,
              // not promising the result fits — at a phone width it does not, and 84 overlapping
              // labels across the Home charts read as a rendering fault rather than a dense axis.
              { color: LABEL, fontSize: 12, interval: labelInterval - 1, hideOverlap: true }
            : { color: LABEL, fontSize: 12, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        scale: fitRange,
        splitLine: { lineStyle: { color: GRID } },
        axisLabel: { color: LABEL, fontSize: 12, formatter: (v: number) => axis(v) },
      },
      series: [
        {
          type: "line",
          data: data.map((d) => d.value),
          smooth: false,
          showSymbol: false,
          // 2.5px: the series is the subject, and a hairline reads as an annotation of the
          // gridlines rather than the thing being plotted.
          lineStyle: { color: LINE, width: 2.5, cap: "round", join: "round" },
          itemStyle: { color: LINE },
          // A single dot on the newest point — the "you are here" marker.
          // "You are here" sits on the last MEASURED point. `?? 0` put it on the x-axis
          // when the newest period had no figure, drawing a zero the engine never said.
          markPoint:
            emphasizeLast && lastMeasured != null
              ? {
                  symbol: "circle",
                  symbolSize: 7,
                  itemStyle: { color: LINE },
                  label: { show: false },
                  data: [{ coord: [lastMeasured.index, lastMeasured.value] }],
                }
              : undefined,
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                // Softer than it was: the fill's job is to show which side of the line is
                // "under", not to be a block of colour competing with the line for the eye.
                { offset: 0, color: washOf(LINE, 0.15) },
                { offset: 1, color: washOf(LINE, 0.01) },
              ],
            },
          },
        },
      ],
    }),
    [data, full, axis, emphasizeLast, labelInterval, fitRange, LINE, GRID, LABEL, lastMeasured],
  );

  return <EChart option={option} height={height} fill={fill} />;
}
