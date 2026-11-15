import { cn } from "@/lib/utils";
import { BAR_GROW, barStyle, drawKey } from "@/lib/chart-draw";

/**
 * Parts of a whole as one bar. Each part's width is its real share; a part of nothing is not
 * drawn. `fill` takes a token class, so both themes follow.
 */
export function SegmentBar({
  parts,
  label,
}: {
  parts: Array<{ key: string; value: number; fill: string }>;
  label: string;
}) {
  const whole = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div
      className="flex h-2 gap-0.5 overflow-hidden rounded-md bg-muted"
      role="img"
      aria-label={label}
    >
      {whole > 0
        ? parts
            .filter((p) => p.value > 0)
            .map((p, i) => (
              <span
                key={`${p.key}:${drawKey([p.value, whole])}`}
                className={cn(BAR_GROW, "h-full", p.fill)}
                style={barStyle((p.value / whole) * 100, i)}
              />
            ))
        : null}
    </div>
  );
}
