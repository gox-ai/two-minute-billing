"use client";

import * as React from "react";
import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { EChart } from "@/components/charts/echart";
import { useChartTokens } from "@/components/charts/bucket-bars";
import { countCompact } from "@/lib/format";

echarts.use([BarChart]);

export interface DailyPoint {
  date: string;
  /** The series: a model value, or the meter when it has no model. */
  series: string;
  quantity: number;
}

const MAX_SERIES = 5;

/** Every YYYY-MM-DD from `from` to `to`, inclusive. */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Usage by day, stacked by model. The five largest models keep their own hue in a fixed order;
 * the rest fold into "Other". Quantities only, never cost.
 */
export function UsageDailyChart({
  points,
  from,
  to,
  height = 220,
}: {
  points: DailyPoint[];
  from: string;
  to: string;
  height?: number;
}) {
  const t = useChartTokens();
  const option = React.useMemo(() => {
    const labels = days(from, to);
    const totals = new Map<string, number>();
    for (const p of points) totals.set(p.series, (totals.get(p.series) ?? 0) + p.quantity);
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = ranked.slice(0, MAX_SERIES);
    const names = ranked.length > MAX_SERIES ? [...top, "Other"] : top;
    const idx = new Map(labels.map((d, i) => [d, i]));
    const data = new Map(names.map((n) => [n, labels.map(() => 0)]));
    for (const p of points) {
      const i = idx.get(p.date);
      if (i == null) continue;
      const name = top.includes(p.series) ? p.series : "Other";
      data.get(name)![i] += p.quantity;
    }
    const read = (v: string, fallback: string) =>
      typeof document === "undefined"
        ? fallback
        : getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fallback;
    const palette = [1, 2, 3, 4, 5].map((n) => read(`--chart-${n}`, t.gain));
    return {
      grid: { left: 48, right: 8, top: 36, bottom: 28 },
      // One row that pages on a narrow screen: a wrapped second row ran into the top y label.
      legend: {
        type: "scroll",
        top: 0,
        left: 0,
        right: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: t.label, fontSize: 12 },
        pageIconColor: t.label,
        pageIconInactiveColor: t.grid,
        pageIconSize: 10,
        pageTextStyle: { color: t.label, fontSize: 12 },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v: number) => Math.round(v).toLocaleString("en-US"),
      },
      xAxis: {
        type: "category",
        data: labels,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: t.grid } },
        axisLabel: { color: t.label, fontSize: 12, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: t.grid } },
        axisLabel: { color: t.label, fontSize: 12, formatter: (n: number) => countCompact(n) },
      },
      series: names.map((n, i) => ({
        name: n,
        type: "bar",
        stack: "usage",
        barMaxWidth: 18,
        itemStyle: {
          color: n === "Other" ? t.neutral : palette[i % palette.length],
          borderColor: read("--card", "#ffffff"),
          borderWidth: 1,
        },
        data: data.get(n),
      })),
    };
  }, [points, from, to, t]);

  if (!points.length)
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">No usage in this range.</p>
    );
  return <EChart option={option} height={height} />;
}
