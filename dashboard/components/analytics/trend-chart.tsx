"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { seriesAxis, seriesValue } from "@/components/analytics/series-format";
import type { PaymentsAnalyticsPoint, PaymentsSeriesKind } from "@/lib/api/analytics";

/**
 * Single-series trend chart, drawn as inline SVG.
 *
 * WHY NOT `components/charts/area-chart.tsx` (the ECharts one on Home): it
 * cannot render a sparkline — its grid and axis padding are fixed. The colour
 * argument that used to sit here is gone: that component pinned one hardcoded
 * blue to both themes at 2.83:1 against the light card, and now resolves
 * `--chart-1` per theme like everything else. This one still takes its colour
 * from `currentColor`, so the caller sets `text-chart-1` and the SEMANTIC TOKEN
 * carries both themes with no `dark:` variant anywhere.
 *
 * Form: the data's job is "trend over time" with ONE series, so the mark is an
 * area — a 2.5px line over a soft wash of the same hue, hairline solid
 * gridlines one step off the surface, and no second axis (a dual-axis chart is
 * the single worst chart mistake, and there is nothing here to pair anyway).
 * One series means no legend box: the card title already names what is plotted.
 *
 * Interaction: a crosshair that snaps to the nearest X — the whole plot is the hit
 * target, so the pointer only has to be closest, never dead-centre on a 2px line.
 * Arrow keys drive the same readout as hover. Values are never tooltip-gated: the
 * y-axis carries them on the full variant, and `View data` opens the table twin.
 */
export interface TrendChartProps {
  points: PaymentsAnalyticsPoint[];
  kind: PaymentsSeriesKind;
  currency: string;
  /** `full` draws axes, gridlines and the table twin; `spark` is the bare mark. */
  variant?: "full" | "spark";
  height?: number;
  /** Names the plotted measure for screen readers and the table twin's caption. */
  label: string;
  className?: string;
}

/** Round an axis maximum up to a clean number so ticks read 0 / 20k / 40k. */
function niceMax(v: number): number {
  if (!(v > 0)) return 0;
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * e;
}

export function TrendChart({
  points,
  kind,
  currency,
  variant = "full",
  height = variant === "full" ? 208 : 40,
  label,
  className,
}: TrendChartProps) {
  const full = variant === "full";
  const ref = React.useRef<HTMLDivElement>(null);
  // Unique per instance: two charts on one page sharing a gradient id would both paint
  // whichever definition the document happened to hold last.
  const fillId = `spark-${React.useId().replace(/:/g, "")}`;
  const [w, setW] = React.useState(0);
  const [active, setActive] = React.useState<number | null>(null);

  // Measured, not a scaled viewBox: `preserveAspectRatio="none"` would stretch
  // the stroke and turn the end-dot into an ellipse.
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const n = points.length;
  // Axis band is INSIDE the fixed height, so the x labels can never be cut off
  // and the card never grows a tiny nested scrollbar.
  const padL = full ? 52 : 1;
  const padR = full ? 10 : 1;
  const padT = full ? 10 : 3;
  const padB = full ? 22 : 3;
  const innerW = Math.max(0, w - padL - padR);
  const innerH = Math.max(0, height - padT - padB);

  const rawMax = n > 0 ? Math.max(...points.map((p) => p.v)) : 0;
  const axisMax = niceMax(rawMax);
  const hasData = axisMax > 0;

  const x = (i: number) => (n <= 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW);
  const y = (v: number) => (hasData ? padT + innerH - (v / axisMax) * innerH : padT + innerH);

  const ready = w > 0 && n > 0;
  const line = ready
    ? points
        .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`)
        .join(" ")
    : "";
  const area = ready
    ? `${line} L${x(n - 1).toFixed(2)},${(padT + innerH).toFixed(2)} L${x(0).toFixed(2)},${(padT + innerH).toFixed(2)} Z`
    : "";

  // Y ticks: 0 / half / max, clean numbers. Dropped entirely when the series is
  // all-zero — inventing a 0.5 tick for a count would be noise.
  const ticks = hasData ? [0, axisMax / 2, axisMax] : [0];

  // One label per ~56px of plot, so ticks are collision-free by construction
  // rather than by hope.
  const labelStep =
    full && innerW > 0 ? Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 56)))) : 1;

  const nearest = (clientX: number) => {
    const el = ref.current;
    if (!el || n === 0) return null;
    const rect = el.getBoundingClientRect();
    if (n === 1) return 0;
    const t = (clientX - rect.left - padL) / (innerW || 1);
    return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setActive((prev) => Math.min(n - 1, Math.max(0, (prev ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  const point = active != null ? points[active] : undefined;
  // Clamp the readout inside the container so it never widens the page.
  const tipLeft =
    active != null && ready
      ? Math.min(Math.max(x(active), padL + 4), Math.max(padL + 4, w - 4))
      : 0;
  const tipAnchorRight = tipLeft > w / 2;

  const summary = `${label}: ${n} point${n === 1 ? "" : "s"}${
    hasData ? `, peak ${seriesValue(rawMax, kind, currency)}` : ", no activity in this period"
  }`;

  return (
    <div className={cn("text-chart-1", className)}>
      <div ref={ref} className="relative w-full" style={{ height }}>
        {ready ? (
          <svg
            width={w}
            height={height}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerMove={(e) => setActive(nearest(e.clientX))}
            onPointerLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
            className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* Gridlines + baseline: solid hairlines one step off the surface. */}
            {ticks.map((t) => (
              <line
                key={`g${t}`}
                x1={padL}
                x2={padL + innerW}
                y1={y(t)}
                y2={y(t)}
                className="stroke-border"
                strokeWidth={1}
              />
            ))}
            {full
              ? ticks.map((t) => (
                  <text
                    key={`t${t}`}
                    x={padL - 8}
                    y={y(t)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-muted-foreground text-xs"
                  >
                    {seriesAxis(t, kind, currency)}
                  </text>
                ))
              : null}
            {full
              ? points.map((p, i) =>
                  i % labelStep === 0 ? (
                    <text
                      key={`x${p.t}`}
                      x={x(i)}
                      y={height - 6}
                      textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                      className="fill-muted-foreground text-xs"
                    >
                      {p.label}
                    </text>
                  ) : null,
                )
              : null}

            {/*
              The mark: the series hue fading out under a 2px line of it.

              A GRADIENT, not a flat wash. A uniform 10% fill reads as a solid block
              wherever the series is tall — it competes with the line for attention and
              makes two adjacent cards look like filled bars rather than trends. Fading to
              transparent at the baseline keeps the eye on the line, which is the thing
              carrying the information, and lets the fill do what it is actually for:
              showing which side of the line is "under".

              `currentColor` throughout, so the hue is whatever the theme's chart token
              resolves to and a `dark:` variant is never needed.
            */}
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.15} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            {hasData ? <path d={area} fill={`url(#${fillId})`} stroke="none" /> : null}
            <path
              d={line}
              fill="none"
              stroke="currentColor"
              strokeWidth={full ? 2.5 : 2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Newest point gets an 8px dot with a 2px surface ring. */}
            <circle
              cx={x(n - 1)}
              cy={y(points[n - 1]?.v ?? 0)}
              r={4}
              fill="currentColor"
              className="stroke-card"
              strokeWidth={2}
            />

            {/* Crosshair: snaps to the nearest X, so no one aims at a 2px line. */}
            {active != null && point ? (
              <>
                <line
                  x1={x(active)}
                  x2={x(active)}
                  y1={padT}
                  y2={padT + innerH}
                  className="stroke-muted-foreground"
                  strokeWidth={1}
                />
                <circle
                  cx={x(active)}
                  cy={y(point.v)}
                  r={4}
                  fill="currentColor"
                  className="stroke-card"
                  strokeWidth={2}
                />
              </>
            ) : null}
          </svg>
        ) : null}

        {/* Readout. Value leads (strong), label follows (secondary) — the reader
            already has the series and wants the number. Text nodes only: point
            labels come off the API and never touch innerHTML. */}
        {active != null && point ? (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
            style={tipAnchorRight ? { right: Math.max(0, w - tipLeft) + 6 } : { left: tipLeft + 6 }}
          >
            <div className="font-semibold text-popover-foreground tabular-nums">
              {seriesValue(point.v, kind, currency)}
            </div>
            <div className="text-muted-foreground">{point.label}</div>
          </div>
        ) : null}
      </div>

      {/* The table twin: every value reachable without hovering. */}
      {full && n > 0 ? (
        <details className="mt-2 text-foreground">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Show data
          </summary>
          <div className="mt-2 max-h-56 overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <caption className="sr-only">{label} by period</caption>
              <thead>
                <tr className="border-b bg-muted/50">
                  <th
                    scope="col"
                    className="px-2.5 py-1.5 text-left font-medium text-muted-foreground"
                  >
                    Period
                  </th>
                  <th
                    scope="col"
                    className="px-2.5 py-1.5 text-right font-medium text-muted-foreground"
                  >
                    {label}
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.t} className="border-b last:border-0">
                    <th
                      scope="row"
                      className="px-2.5 py-1.5 text-left font-normal text-muted-foreground"
                    >
                      {p.label}
                    </th>
                    <td className="px-2.5 py-1.5 text-right">{seriesValue(p.v, kind, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}
