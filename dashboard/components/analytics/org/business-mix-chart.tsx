"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { useThemeStamp } from "@/components/charts/theme-stamp";
import { EChart } from "@/components/charts/echart";
import { washOf } from "@/components/charts/area-chart";
import { money, countCompact, pctFromBps, toMajor } from "@/lib/format";
import type { MeasureUnit } from "@/lib/analytics-api";

/**
 * The five theme chart tokens, resolved from the document.
 *
 * ECharts paints to SVG and cannot read a CSS custom property, so each one is read off
 * `:root` and re-read when the theme changes — the same contract `useChartLine` documents.
 * The fallbacks are theme-aware: a light-theme palette on a dark card is worse than no chart.
 */
const LIGHT = ["#4e4eda", "#067647", "#0284c7", "#7c9ec9", "#b42318"];
const DARK = ["#8b8bf2", "#4ac68b", "#38bdf8", "#7f9cc0", "#ef7f75"];
const GRID = "rgba(128,128,128,0.18)";
const LABEL = "#9ca3af";

function useChartPalette(): string[] {
  const { resolvedTheme } = useTheme();
  const stamp = useThemeStamp();
  return React.useMemo(() => {
    const fallback = resolvedTheme === "dark" ? DARK : LIGHT;
    if (typeof document === "undefined") return LIGHT;
    const root = getComputedStyle(document.documentElement);
    return fallback.map((f, i) => root.getPropertyValue(`--chart-${i + 1}`).trim() || f);
  }, [resolvedTheme, stamp]);
}

export interface MixSeries {
  key: string;
  label: string;
  /** One value per period, aligned to `periods`. `null` is an unmeasured period, not zero. */
  values: Array<number | null>;
}

/**
 * One measure over time, stacked by business — the composition of the portfolio, not four
 * charts side by side.
 *
 * Every series comes from the SAME answer: the fact table carries `business_id`, so the split
 * arrives with one query. A business the roll-up could not convert is not drawn, and
 * `notDrawn` names it under the chart rather than letting its absence read as zero.
 */
export function BusinessMixChart({
  periods,
  series,
  unit,
  currency,
  notDrawn = [],
  height = 240,
}: {
  periods: string[];
  series: MixSeries[];
  unit: MeasureUnit;
  currency: string | null;
  notDrawn?: string[];
  height?: number;
}) {
  const palette = useChartPalette();

  const full = React.useCallback(
    (n: number) =>
      unit === "money"
        ? money(Math.round(n), currency ?? "USD")
        : unit === "bps"
          ? pctFromBps(Math.round(n))
          : Math.round(n).toLocaleString("en"),
    [unit, currency],
  );
  const axis = React.useCallback(
    (n: number) =>
      unit === "money"
        ? // `toMajor`, not `/100`: the divisor is the CURRENCY's exponent.
          countCompact(toMajor(Math.round(n), currency ?? "USD"))
        : unit === "bps"
          ? pctFromBps(Math.round(n), 1)
          : countCompact(n),
    [unit, currency],
  );

  const option = React.useMemo(
    () => ({
      grid: { left: 60, right: 16, top: 14, bottom: 26 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => full(v) },
      xAxis: {
        type: "category",
        data: periods,
        boundaryGap: false,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: GRID } },
        axisLabel: { color: LABEL, fontSize: 12, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: GRID } },
        axisLabel: { color: LABEL, fontSize: 12, formatter: (v: number) => axis(v) },
      },
      series: series.map((s, i) => {
        const colour = palette[i % palette.length]!;
        return {
          name: s.label,
          type: "line",
          // Stacked, because the question this screen asks is what the portfolio is MADE of.
          stack: "total",
          data: s.values,
          smooth: false,
          showSymbol: false,
          lineStyle: { color: colour, width: 1.5 },
          itemStyle: { color: colour },
          areaStyle: { color: washOf(colour, 0.3) },
        };
      }),
    }),
    [periods, series, palette, full, axis],
  );

  return (
    <div className="space-y-3">
      <EChart option={option} height={height} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {series.map((s, i) => (
          <span
            key={s.key}
            className="inline-flex items-center gap-2 text-xs text-muted-foreground"
          >
            {/* The TOKEN, not the resolved hex: the swatch is ordinary DOM, so CSS can
                answer the theme for it. Handing it the value `useChartPalette` read off the
                document makes the server and client renders disagree — a hydration mismatch
                React will not patch up. Only ECharts, which cannot read a custom property,
                gets the resolved colour. */}
            <span
              className="size-2 rounded-sm"
              style={{ background: `var(--chart-${(i % palette.length) + 1})` }}
              aria-hidden
            />
            {s.label}
          </span>
        ))}
        {notDrawn.map((label) => (
          <span key={label} className="inline-flex items-center gap-2 text-xs text-warning">
            <span className="size-2 rounded-sm border border-warning" aria-hidden />
            {label}: no rate, not drawn
          </span>
        ))}
      </div>
    </div>
  );
}
