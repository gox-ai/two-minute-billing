"use client";

import { useState } from "react";
import { RecordCard } from "@/components/patterns/record-page";
import { cn } from "@/lib/utils";
import { ChangeBars } from "@/components/charts/bucket-bars";
import { countCompact, toMajor } from "@/lib/format";
import { reportValue, type ReportKind } from "@/components/reports/report-format";
import type { SeriesPolarity } from "@/components/analytics/series-format";

/**
 * Period-over-period CHANGE in the metric, as bars off a zero axis.
 *
 * The chart above states the level, which is the wrong shape for "is this accelerating".
 * A level that climbs from 700K to 760K to 770K looks like steady growth until you plot
 * the change and see 60K, then 10K.
 *
 * Colour is direction × POLARITY, never direction alone: a bar is green because the change
 * was good news, not because it points up. A rising refund total is a loss and renders as
 * one. Where the caller has no recorded direction the bars stay in muted ink rather than
 * borrowing a semantic colour they have not earned, and the axis carries the sign on its
 * own — above the line is a gain, below it a loss.
 *
 * Derived from the same monthly series the rest of the page reads, never re-fetched — two
 * requests for one metric can straddle a sync and disagree with each other on screen.
 */

interface Point {
  label: string;
  v: number;
}

/** Span options, in months of the SOURCE series. */
const SPANS = [6, 12] as const;

/**
 * Change per step. `grain` of 3 reads quarter over quarter off the same monthly points:
 * the level at a quarter's end minus the level three months earlier, which is a real
 * figure and not a re-aggregation of one.
 */
function changes(points: Point[], grain: number): Array<{ label: string; delta: number }> {
  const out: Array<{ label: string; delta: number }> = [];
  for (let i = grain; i < points.length; i += grain) {
    out.push({ label: points[i]!.label, delta: points[i]!.v - points[i - grain]!.v });
  }
  return out;
}

export function GrowthBars({
  points,
  kind,
  currency,
  polarity = "neutral",
}: {
  points: Point[];
  kind: ReportKind;
  currency: string;
  /** Whether a RISE in this figure is good news. `neutral` keeps the bars in muted ink. */
  polarity?: SeriesPolarity;
}) {
  const [span, setSpan] = useState<number>(12);
  const [grain, setGrain] = useState<number>(1);

  const windowed = points.slice(-span);
  const bars = changes(windowed, grain);

  // Every bar zero means the series never moved across the window — a row of flat stubs
  // under a heading claims a measurement that says nothing. Nothing to draw.
  const peak = Math.max(...bars.map((b) => Math.abs(b.delta)), 0);
  if (bars.length === 0 || peak === 0) return null;

  const gainIsGood = polarity === "neutral" ? null : polarity === "up_good";

  return (
    <RecordCard
      title={grain === 1 ? "Month-over-month change" : "Quarter-over-quarter change"}
      actions={
        <>
          <Toggle
            label="Step"
            items={[
              { id: 1, label: "Monthly" },
              { id: 3, label: "Quarterly" },
            ]}
            current={grain}
            onPick={setGrain}
          />
          <Toggle
            label="Span"
            items={SPANS.map((s) => ({ id: s, label: `${s}m` }))}
            current={span}
            onPick={setSpan}
          />
        </>
      }
      footer={
        <span className="text-xs text-muted-foreground">
          Each bar is the change from the previous {grain === 1 ? "month" : "quarter"}.
        </span>
      }
    >
      <ChangeBars
        labels={bars.map((b) => b.label)}
        values={bars.map((b) => b.delta)}
        goodWhenUp={gainIsGood}
        formatValue={(v) => reportValue(v, kind, currency)}
        formatAxis={(v) =>
          kind === "money"
            ? countCompact(toMajor(Math.round(v), currency))
            : kind === "rate"
              ? `${(v / 100).toFixed(0)}%`
              : kind === "ratio"
                ? `${(v / 10000).toFixed(1)}×`
                : countCompact(v)
        }
        seriesLabel="Change"
      />
    </RecordCard>
  );
}

/** A small segmented toggle; local state, so plain pressed buttons. */
function Toggle({
  label,
  items,
  current,
  onPick,
}: {
  label: string;
  items: Array<{ id: number; label: string }>;
  current: number;
  onPick: (id: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center rounded-md border bg-card p-0.5"
    >
      {items.map((it) => {
        const on = it.id === current;
        return (
          <button
            key={it.id}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(it.id)}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium transition-colors sm:h-7",
              on
                ? "bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
