"use client";

import * as React from "react";
import * as echarts from "echarts/core";
import { LineChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { useThemeStamp } from "@/components/charts/theme-stamp";

echarts.use([LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

/**
 * Thin React wrapper around Apache ECharts (no third-party React binding, so it
 * stays clean on React 19). Inits on the div, keeps the option in sync, resizes
 * with its container, and re-themes on light/dark switch.
 */
export function EChart({
  option,
  height = 240,
  fill = false,
}: {
  option: echarts.EChartsCoreOption;
  height?: number;
  /** Take the parent's height instead, never below `height`. The parent must be `relative`. */
  fill?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);
  const stamp = useThemeStamp();

  React.useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option, stamp]);

  return fill ? (
    <div className="relative h-full w-full" style={{ minHeight: height }}>
      <div ref={ref} className="absolute inset-0" />
    </div>
  ) : (
    <div ref={ref} style={{ height, width: "100%" }} />
  );
}
