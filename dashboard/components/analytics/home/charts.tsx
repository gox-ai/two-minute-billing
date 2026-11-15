"use client";

import * as React from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { EChart } from "@/components/charts/echart";
import { countCompact, pctFromBps } from "@/lib/format";
import { axisMinInterval, successRates } from "@/components/charts/axis";
import { formatters, useChartTokens } from "@/components/charts/bucket-bars";

export { BucketBars } from "@/components/charts/bucket-bars";

echarts.use([BarChart, LineChart]);

/**
 * MRR movement per bucket: gains stacked above the axis, losses below, net new as a line.
 * Losses arrive as positive magnitudes and are drawn negative here.
 */
export function MovementBars({
  labels,
  newMrr,
  expansion,
  losses,
  net,
  currency,
  height = 240,
}: {
  labels: string[];
  newMrr: Array<number | null>;
  expansion: Array<number | null>;
  losses: Array<number | null>;
  net: Array<number | null>;
  currency: string;
  height?: number;
}) {
  const t = useChartTokens();
  const f = React.useMemo(() => formatters("money", currency), [currency]);
  const option = React.useMemo(
    () => ({
      grid: { left: 56, right: 8, top: 12, bottom: 28 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v: number) => f.full(v),
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
        axisLabel: { color: t.label, fontSize: 12, formatter: (v: number) => f.axis(v) },
      },
      series: [
        {
          name: "New",
          type: "bar",
          stack: "gain",
          data: newMrr,
          barMaxWidth: 28,
          itemStyle: { color: t.gain },
        },
        {
          name: "Expansion + reactivation",
          type: "bar",
          stack: "gain",
          data: expansion,
          barMaxWidth: 28,
          itemStyle: { color: t.soft },
        },
        {
          name: "Churn + contraction",
          type: "bar",
          stack: "loss",
          data: losses.map((v) => (v == null ? null : -v)),
          barMaxWidth: 28,
          barGap: "-100%",
          itemStyle: { color: t.loss },
        },
        {
          name: "Net new MRR",
          type: "line",
          data: net,
          showSymbol: false,
          lineStyle: { color: t.ink, width: 2 },
          itemStyle: { color: t.ink },
          z: 4,
        },
      ],
    }),
    [labels, newMrr, expansion, losses, net, t, f],
  );
  return <EChart option={option} height={height} />;
}

/**
 * Payment attempts per bucket with the failures among them overlaid, on one count axis. The
 * success rate is the card's figure and sparkline, not a second axis here; the tooltip still
 * gives each bucket's rate ("—" for a bucket with no attempts).
 */
export function AttemptsChart({
  labels,
  attempts,
  failures,
  height = 200,
}: {
  labels: string[];
  attempts: Array<number | null>;
  failures: Array<number | null>;
  height?: number;
}) {
  const t = useChartTokens();
  const option = React.useMemo(() => {
    const rate = successRates(attempts, failures);
    return {
      grid: { left: 44, right: 8, top: 12, bottom: 28 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: Array<{ dataIndex: number; axisValueLabel: string }>) => {
          const i = ps[0]?.dataIndex ?? 0;
          const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en"));
          const r = rate[i];
          return [
            ps[0]?.axisValueLabel ?? "",
            `Attempts: ${n(attempts[i])}`,
            `Failed: ${n(failures[i])}`,
            `Success rate: ${r == null ? "—" : pctFromBps(Math.round(r * 10000), 1)}`,
          ].join("<br/>");
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
        minInterval: axisMinInterval("count"),
        splitLine: { lineStyle: { color: t.grid } },
        axisLabel: { color: t.label, fontSize: 12, formatter: (v: number) => countCompact(v) },
      },
      series: [
        {
          name: "Attempts",
          type: "bar",
          data: attempts,
          barMaxWidth: 18,
          itemStyle: { color: t.soft, borderRadius: [3, 3, 0, 0] },
        },
        {
          name: "Failed",
          type: "bar",
          data: failures,
          barMaxWidth: 18,
          barGap: "-100%",
          itemStyle: { color: t.loss, borderRadius: [3, 3, 0, 0] },
        },
      ],
    };
  }, [labels, attempts, failures, t]);
  return <EChart option={option} height={height} />;
}
