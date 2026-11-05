"use client";

import * as React from "react";
import { BOARD_COLUMNS, MAX_ROWS, ROW_UNIT_PX, sameUnits, type TileUnits } from "./span";

type Axis = "x" | "y" | "both";

/**
 * The selected tile's resize handles. They exist only while arranging, and only on the
 * selected tile — pull one, or focus it and use the arrow keys.
 *
 * A corner handle is legitimate now: height used to follow the content, so a corner would
 * have been a control that does nothing. Since 0270 a tile stores its own height, so the
 * corner moves both axes at once.
 */
export function ResizeEdges({
  label,
  units,
  min,
  constraint,
  disabled,
  stepPx,
  onPreview,
  onCommit,
}: {
  label: string;
  units: TileUnits;
  min: TileUnits;
  constraint: string;
  disabled: boolean;
  /** One column plus one gap, in px — measured off the live grid. */
  stepPx: () => number;
  onPreview: (units: TileUnits | null) => void;
  onCommit: (units: TileUnits) => void;
}) {
  const shared = { label, units, min, disabled, stepPx, onPreview, onCommit };
  return (
    <>
      <Handle {...shared} side="left" />
      <Handle {...shared} side="right" />
      <Handle {...shared} side="bottom" />
      <Handle {...shared} side="corner" />
      <span className="absolute -top-3 right-4 inline-flex h-6 items-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground">
        {units.width} of {BOARD_COLUMNS} columns · {units.height} rows
      </span>
      <span className="absolute -bottom-6 left-0.5 text-xs text-muted-foreground">
        {constraint}
      </span>
    </>
  );
}

const AXIS: Record<string, Axis> = { left: "x", right: "x", bottom: "y", corner: "both" };

const CHROME: Record<string, string> = {
  left: "top-1/2 -mt-4 h-8 w-3 -left-1.5 cursor-ew-resize",
  right: "top-1/2 -mt-4 h-8 w-3 -right-1.5 cursor-ew-resize",
  bottom: "left-1/2 -ml-4 h-3 w-8 -bottom-1.5 cursor-ns-resize",
  corner: "h-4 w-4 -right-2 -bottom-2 cursor-nwse-resize",
};

function Handle({
  side,
  label,
  units,
  min,
  disabled,
  stepPx,
  onPreview,
  onCommit,
}: {
  side: "left" | "right" | "bottom" | "corner";
  label: string;
  units: TileUnits;
  min: TileUnits;
  disabled: boolean;
  stepPx: () => number;
  onPreview: (units: TileUnits | null) => void;
  onCommit: (units: TileUnits) => void;
}) {
  const axis = AXIS[side]!;
  // Dragging a left handle leftwards widens; every other handle widens outwards.
  const outward = side === "left" ? -1 : 1;
  const drag = React.useRef<{ x: number; y: number; from: TileUnits } | null>(null);

  const clamp = (u: TileUnits): TileUnits => ({
    width: Math.min(BOARD_COLUMNS, Math.max(min.width, Math.round(u.width))),
    height: Math.min(MAX_ROWS, Math.max(min.height, Math.round(u.height))),
  });

  const at = (clientX: number, clientY: number): TileUnits => {
    const step = stepPx();
    const d = drag.current;
    if (!d || step <= 0) return units;
    return clamp({
      width: axis === "y" ? d.from.width : d.from.width + ((clientX - d.x) * outward) / step,
      height: axis === "x" ? d.from.height : d.from.height + (clientY - d.y) / ROW_UNIT_PX,
    });
  };

  const end = (e: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const from = drag.current?.from;
    if (from == null) return;
    // Compare with where the drag STARTED, not with `units`: the live preview has already
    // moved that prop, so comparing against it makes every commit a no-op.
    const next = commit ? at(e.clientX, e.clientY) : from;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    onPreview(null);
    if (commit && !sameUnits(next, from)) onCommit(next);
  };

  /** Arrow keys move the axis this handle owns; the corner owns both. */
  const byKey = (key: string): TileUnits | null => {
    const wide = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
    const tall = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
    if (wide === 0 && tall === 0) return null;
    if (axis === "x" && wide === 0) return null;
    if (axis === "y" && tall === 0) return null;
    return clamp({
      width: units.width + (axis === "y" ? 0 : wide * outward),
      height: units.height + (axis === "x" ? 0 : tall),
    });
  };

  return (
    <button
      type="button"
      disabled={disabled}
      data-resize={side}
      aria-label={`Resize ${label} from the ${side === "corner" ? "corner" : `${side} edge`}. It is ${units.width} of ${BOARD_COLUMNS} columns and ${units.height} rows. Drag, or use the arrow keys.`}
      className={
        "absolute z-10 rounded-md border-2 border-primary bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default disabled:opacity-50 " +
        CHROME[side]
      }
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, from: units };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onPreview(at(e.clientX, e.clientY));
      }}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onKeyDown={(e) => {
        const next = byKey(e.key);
        if (!next) return;
        e.preventDefault();
        if (!sameUnits(next, units)) onCommit(next);
      }}
    />
  );
}
