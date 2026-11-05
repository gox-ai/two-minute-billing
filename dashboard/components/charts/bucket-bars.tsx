"use client";

import * as React from "react";
import * as echarts from "echarts/core";
import { BarChart, ScatterChart } from "echarts/charts";
import { useTheme } from "next-themes";
import { useThemeStamp } from "@/components/charts/theme-stamp";
import { EChart } from "@/components/charts/echart";
import { money, countCompact, toMajor } from "@/lib/format";

echarts.use([BarChart, ScatterChart]);

/** Theme tokens resolved for ECharts, which paints SVG and cannot read a CSS variable. */
export function useChartTokens() {
  const { resolvedTheme } = useTheme();
  const stamp = useThemeStamp();
  return React.useMemo(() => {
    const read = (v: string, fallback: string) =>
      typeof document === "undefined"
        ? fallback
        : getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fallback;
    return {
      gain: read("--chart-1", "#4e4eda"),
      soft: read("--chart-4", "#7c9ec9"),
      loss: read("--chart-5", "#b42318"),
      neutral: read("--muted-foreground", "#64748b"),
      ink: read("--foreground", "#101828"),
      grid: read("--border", "rgba(128,128,128,0.18)"),
      label: read("--muted-foreground", "#9ca3af"),
    };
    // `stamp` re-reads once the new theme is on <html> (see theme-stamp).
  }, [resolvedTheme, stamp]);
}

export type BarKind = "money" | "count";

export function formatters(kind: BarKind, currency: string) {
  return {
    full: (n: number | null | undefined) =>
      n == null || !Number.isFinite(n)
        ? "no figure"
        : kind === "money"
          ? money(Math.round(n), currency)
          : Math.round(n).toLocaleString("en"),
    axis: (n: number) =>
      !Number.isFinite(n)
        ? ""
        : kind === "money"
          ? countCompact(toMajor(Math.round(n), currency))
          : countCompact(n),
  };
}

/**
 * One series as bars, one per bucket. `markers` flags buckets that carry a second, sparser
 * event (a paying customer added) as a dot under the axis; its count shows in the tooltip.
 * `part` is a share of each bar drawn in the loss hue on top of the rest in a neutral hue, so
 * the bars read with a two-colour legend beneath them.
 */
export function BucketBars({
  labels,
  values,
  markers,
  markerLabel,
  part,
  notes,
  seriesLabel,
  tone,
  kind,
  currency = "USD",
  height = 180,
  barMaxWidth = 18,
}: {
  labels: string[];
  values: Array<number | null>;
  markers?: Array<number | null>;
  markerLabel?: string;
  /** The loss-hued share of each bar; `tone` is ignored when given. */
  part?: { label: string; values: Array<number | null> };
  /** An extra tooltip line per bucket. */
  notes?: Array<string | null>;
  seriesLabel: string;
  /** `brand`: brand bars with ink markers. */
  tone: "soft" | "loss" | "brand";
  kind: BarKind;
  currency?: string;
  height?: number;
  /** Wider bars when there are few buckets (a year of months). */
  barMaxWidth?: number;
}) {
  const t = useChartTokens();
  const f = React.useMemo(() => formatters(kind, currency), [kind, currency]);
  const option = React.useMemo(() => {
    const hasMarkers = markers?.some((m) => (m ?? 0) > 0) ?? false;
    return {
      grid: { left: 44, right: 8, top: 12, bottom: hasMarkers ? 40 : 28 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: Array<{ dataIndex: number; axisValueLabel: string }>) => {
          const i = ps[0]?.dataIndex ?? 0;
          const lines = [`${ps[0]?.axisValueLabel ?? ""}`, `${seriesLabel}: ${f.full(values[i])}`];
          if (part) lines.push(`${part.label}: ${f.full(part.values[i] ?? 0)}`);
          const m = markers?.[i];
          if (markerLabel && m != null && m > 0)
            lines.push(`${markerLabel}: ${m.toLocaleString("en")}`);
          const note = notes?.[i];
          if (note) lines.push(note);
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: labels,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: t.grid } },
        axisLabel: { color: t.label, fontSize: 12, hideOverlap: true, margin: hasMarkers ? 20 : 8 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: t.grid } },
        axisLabel: { color: t.label, fontSize: 12, formatter: (v: number) => f.axis(v) },
      },
      series: [
        ...(part
          ? [
              {
                type: "bar",
                stack: "total",
                barMaxWidth,
                data: values.map((v, i) => {
                  if (v == null) return null;
                  const top = part.values[i] ?? 0;
                  return {
                    value: v - top,
                    // The rest of the bar is neutral, so only the loss-hued share reads as a warning.
                    itemStyle: { color: t.neutral, borderRadius: top > 0 ? 0 : [3, 3, 0, 0] },
                  };
                }),
              },
              {
                type: "bar",
                stack: "total",
                barMaxWidth,
                data: part.values.map((v) => (v ? v : null)),
                itemStyle: { color: t.loss, borderRadius: [3, 3, 0, 0] },
              },
            ]
          : [
              {
                type: "bar",
                data: values,
                barMaxWidth,
                itemStyle: {
                  color: tone === "loss" ? t.loss : tone === "brand" ? t.gain : t.soft,
                  borderRadius: [3, 3, 0, 0],
                },
              },
            ]),
        ...(hasMarkers
          ? [
              {
                type: "scatter",
                data: (markers ?? []).map((m) => ((m ?? 0) > 0 ? 0 : null)),
                symbolSize: 6,
                symbolOffset: [0, 10],
                itemStyle: { color: tone === "brand" ? t.ink : t.gain },
                z: 3,
              },
            ]
          : []),
      ],
    };
  }, [labels, values, markers, markerLabel, part, notes, seriesLabel, tone, t, f, barMaxWidth]);
  return <EChart option={option} height={height} />;
}

/**
 * Period-over-period change as bars either side of zero. A change in the good direction is
 * the brand hue, one in the bad direction the loss hue; with no polarity both stay neutral.
 */
export function ChangeBars({
  labels,
  values,
  goodWhenUp,
  formatValue,
  formatAxis,
  seriesLabel,
  height = 200,
}: {
  labels: string[];
  values: Array<number | null>;
  /** `null`: the measure has no good direction. */
  goodWhenUp: boolean | null;
  /** Client-side only: this chart is rendered from a client component. */
  formatValue: (n: number) => string;
  formatAxis: (n: number) => string;
  seriesLabel: string;
  height?: number;
}) {
  const t = useChartTokens();
  const option = React.useMemo(() => {
    const colour = (v: number) =>
      goodWhenUp == null ? t.soft : v >= 0 === goodWhenUp ? t.gain : t.loss;
    return {
      grid: { left: 56, right: 8, top: 12, bottom: 28 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: Array<{ dataIndex: number; axisValueLabel: string }>) => {
          const v = values[ps[0]?.dataIndex ?? 0];
          const sign = v != null && v > 0 ? "+" : "";
          return `${ps[0]?.axisValueLabel ?? ""}<br/>${seriesLabel}: ${v == null ? "no figure" : sign + formatValue(v)}`;
        },
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
        axisLabel: { color: t.label, fontSize: 12, formatter: (v: number) => formatAxis(v) },
      },
      series: [
        {
          type: "bar",
          data: values.map((v) =>
            v == null
              ? null
              : {
                  value: v,
                  itemStyle: {
                    color: colour(v),
                    borderRadius: v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3],
                  },
                },
          ),
          barMaxWidth: labels.length <= 16 ? 32 : 18,
        },
      ],
    };
  }, [labels, values, goodWhenUp, formatValue, formatAxis, seriesLabel, t]);
  return <EChart option={option} height={height} />;
}
