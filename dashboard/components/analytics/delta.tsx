"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { pctFromBps } from "@/lib/format";
import type { SeriesPolarity } from "@/components/analytics/series-format";

/**
 * `↑ 63.4%` — the change vs the previous period.
 *
 * The tone is direction × POLARITY, so a rise in refunds never renders green, and
 * a measure whose direction is neither good nor bad stays in muted ink rather than
 * borrowing a semantic colour it hasn't earned.
 *
 * The arrow is an icon and the tone is a colour — neither reaches a screen reader —
 * so the direction is also spelled out in sr-only text. Hue never carries the sign
 * alone.
 *
 * Past ±1000% it switches to a multiple: a young business swings by five figures of
 * percent, which is true but unreadable and overflows the tile.
 */
export function Delta({
  bps,
  polarity,
  size = "sm",
}: {
  bps: number;
  polarity: SeriesPolarity;
  /** `sm` on a KPI tile, `md` beside a lead card's larger headline. */
  size?: "sm" | "md";
}) {
  const down = bps < 0;
  const Icon = down ? ArrowDown : ArrowUp;
  const abs = Math.abs(bps);
  const text =
    abs >= 100_000 ? `${Math.round(abs / 10_000).toLocaleString("en")}×` : pctFromBps(abs, 1);
  const good = polarity === "neutral" ? null : polarity === "up_good" ? !down : down;
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 font-medium " +
        (size === "md" ? "text-sm " : "") +
        (good == null ? "text-muted-foreground" : good ? "text-success" : "text-destructive")
      }
    >
      <Icon className={size === "md" ? "size-3.5" : "size-3"} aria-hidden />
      <span className="sr-only">{down ? "down " : "up "}</span>
      {text}
    </span>
  );
}
