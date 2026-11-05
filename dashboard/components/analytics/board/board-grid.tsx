"use client";

import * as React from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Maximize2, Minimize2, X } from "lucide-react";
import { EXPLORE_RANGES } from "@/components/analytics/cut-options";
import { dimensionLabel } from "@/components/reports/report-format";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/states";
import { roleOfResult, type MeasureTileRole } from "@/components/analytics/role";
import { MeasureTile } from "@/components/analytics/measure-tile";
import { ColumnGuides } from "@/components/analytics/board/column-guides";
import { DropSlot } from "@/components/analytics/board/drop-slot";
import { ResizeEdges } from "@/components/analytics/board/resize-edges";
import {
  BOARD_COLUMNS,
  ROW_UNIT_PX,
  clampUnits,
  constraintLine,
  minHeight,
  minWidth,
  placements,
  spanClass,
  type TileUnits,
} from "@/components/analytics/board/span";
import type { AnalyticsResult } from "@/lib/analytics-api";

/**
 * The tile grid — the ONE grid every saved dashboard renders through.
 *
 * A tile is a measure, drawn by `MeasureTile`, the same component Explore renders a single
 * measure with: one vocabulary on every screen, so a figure cannot say one thing here and
 * another there. A stored key the semantic layer does not know says so on the tile.
 *
 * Arranging is a MODE, owned by `BoardSurface`. At rest a tile carries no chrome at all; every
 * handle, every guide and every size control exists only while `arranging`, and every change
 * lands in the surface's draft rather than on the server.
 */

export interface BoardTile {
  id: string;
  report_key: string;
  name: string | null;
  available: boolean;
  range: string | null;
  currency: string | null;
  group_by: string | null;
  granularity: string | null;
  /** Null is `series`: the answer carries its periods. */
  shape: "series" | "totals" | null;
  /** Null is the whole book. */
  segment_id: string | null;
  /** True while the board's custom window is answering in place of this tile's own range. */
  range_overridden?: boolean;
  /** Columns of twelve, and rows of `ROW_UNIT_PX` — the engine's own units. */
  width_units: number;
  height_units: number;
  result: AnalyticsResult | null;
  /** Set when `available` but the engine refused this tile's pinned options. */
  error: string | null;
}

function resultIsEmpty(r: AnalyticsResult): boolean {
  return r.total == null && r.series.length === 0 && (!r.split || r.split.series.length === 0);
}

function roleOf(tile: BoardTile): MeasureTileRole {
  return tile.result ? roleOfResult(tile.result) : "figure";
}

function labelOf(tile: BoardTile): string {
  return tile.name ?? tile.report_key;
}

const GRAIN_ADVERB: Record<string, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

/** The tile's saved settings in plain words: "Last 12 months · Monthly · High MRR segment". */
function PinnedOptions({ tile }: { tile: BoardTile }) {
  const parts = [
    // A custom board window answers in place of the tile's range, so the tile's own range is
    // not what the figure covers — printing it would contradict the number beneath it.
    tile.range_overridden || !tile.range
      ? null
      : (EXPLORE_RANGES.find((r) => r.id === tile.range)?.label ?? tile.range),
    tile.granularity ? (GRAIN_ADVERB[tile.granularity] ?? tile.granularity) : null,
    tile.group_by ? `By ${dimensionLabel(tile.group_by).toLowerCase()}` : null,
    // The name comes off the answer; a tile stores only the id. An unanswered tile still says
    // it is scoped, so nobody reads a segment's figure as the whole book's.
    tile.segment_id ? `${tile.result?.segment?.name ?? "Customer"} segment` : null,
    tile.currency ? `In ${tile.currency}` : null,
  ].filter((p): p is string => p != null);
  if (parts.length === 0) return null;
  return <span className="mt-0.5 block text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}

function TileBody({ tile, biz }: { tile: BoardTile; biz: string }) {
  if (!tile.available) {
    return (
      <Alert tone="warning" title="This measure is no longer available">
        <span className="font-mono text-xs">{tile.report_key}</span> is not in the semantic layer
        now. Remove the tile, or keep it until the measure returns.
      </Alert>
    );
  }
  if (!tile.result) {
    return (
      <Alert tone="error" title="We could not calculate this tile">
        {tile.error ?? "The measure refused the options pinned on this tile."}
      </Alert>
    );
  }
  if (resultIsEmpty(tile.result)) {
    return (
      <EmptyState
        title="Nothing to report yet"
        description="This tile has no figures for its period."
      />
    );
  }
  // The segment's membership note is printed by the tile's own footer, with the other
  // housekeeping lines, so it is not repeated here.
  // A block wrapper, so the tile's `h-full` does not stretch to a taller row partner and push
  // its footnote away from the figure: spare room falls below the footnote.
  return (
    <div>
      <MeasureTile result={tile.result} biz={biz} />
    </div>
  );
}

/**
 * The tile itself. `chrome` is everything that only exists while arranging; `actions` is
 * what the tile carries at rest, revealed on hover so a page of numbers stays a page of
 * numbers.
 */
function TileCard({
  tile,
  biz,
  selected,
  lifted,
  chrome,
  actions,
}: {
  tile: BoardTile;
  biz: string;
  selected: boolean;
  lifted: boolean;
  chrome: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const label = labelOf(tile);
  return (
    <section
      className={
        "anim-rise group flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card" +
        (selected ? " border-2 border-primary" : "") +
        (lifted ? " border-primary shadow-lg" : "")
      }
    >
      <div className="flex items-start gap-2 border-b px-5 py-3.5">
        {chrome}
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold wrap-break-word">{label}</h2>
          <PinnedOptions tile={tile} />
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {tile.available ? (
            <Link
              href={`/businesses/${biz}/reports/explore?measure=${encodeURIComponent(tile.report_key)}`}
              aria-label={`Open ${label} in Explore`}
              className="text-sm text-primary hover:underline"
            >
              Explore
            </Link>
          ) : null}
          {actions}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <TileBody tile={tile} biz={biz} />
      </div>
    </section>
  );
}

function SortableTile({
  tile,
  biz,
  units,
  arranging,
  canEdit,
  selected,
  saving,
  row,
  start,
  stepPx,
  onSelect,
  onRemove,
  onResize,
  onPreview,
}: {
  tile: BoardTile;
  biz: string;
  units: TileUnits;
  arranging: boolean;
  canEdit: boolean;
  selected: boolean;
  saving: boolean;
  row: number;
  start: number;
  stepPx: () => number;
  onSelect: () => void;
  onRemove: () => void;
  onResize: (units: TileUnits) => void;
  onPreview: (units: TileUnits | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tile.id,
    disabled: !arranging,
  });

  const role = roleOf(tile);
  const min: TileUnits = { width: minWidth(role), height: minHeight(role) };
  const label = labelOf(tile);

  const chrome = arranging ? (
    <>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Move ${label}`}
        className="-ml-1 inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>
      {selected ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={saving || units.width <= min.width}
            title={`Narrower (now ${units.width} of ${BOARD_COLUMNS} columns)`}
            aria-label={`Make ${label} narrower. It is ${units.width} of ${BOARD_COLUMNS} columns now`}
            onClick={() => onResize({ ...units, width: Math.max(min.width, units.width - 1) })}
          >
            <Minimize2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={saving || units.width >= BOARD_COLUMNS}
            title={`Wider (now ${units.width} of ${BOARD_COLUMNS} columns)`}
            aria-label={`Make ${label} wider. It is ${units.width} of ${BOARD_COLUMNS} columns now`}
            onClick={() => onResize({ ...units, width: Math.min(BOARD_COLUMNS, units.width + 1) })}
          >
            <Maximize2 className="size-3.5" />
          </Button>
        </span>
      ) : null}
    </>
  ) : null;

  /**
   * Removing belongs to editing, not to reading. At rest a board is a page of numbers and
   * carries no chrome at all — and a removal there would commit immediately, outside the
   * draft, so "nothing is saved until Save layout" would not be true of every change.
   * While editing it is on EVERY tile rather than the selected one: a control you must
   * first discover by clicking the right card is a missing control.
   */
  const actions =
    canEdit && arranging ? (
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground"
        disabled={saving}
        aria-label={`Remove ${label} from this dashboard`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        <X className="size-3.5" />
      </Button>
    ) : null;

  return (
    <div
      ref={setNodeRef}
      // `minHeight`, not `height`: the set height is what the row stands at, and a tile
      // whose content outgrows it still shows all of it rather than clipping a figure.
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        minHeight: units.height * ROW_UNIT_PX,
      }}
      className={"relative min-w-0 " + spanClass(units.width)}
      onFocusCapture={arranging ? onSelect : undefined}
      onClick={
        arranging
          ? (e) => {
              e.stopPropagation();
              onSelect();
            }
          : undefined
      }
    >
      {isDragging ? (
        <DropSlot columns={units.width} row={row} start={start} />
      ) : (
        <>
          <TileCard
            tile={tile}
            biz={biz}
            selected={arranging && selected}
            lifted={false}
            chrome={chrome}
            actions={actions}
          />
          {arranging && selected ? (
            <ResizeEdges
              label={label}
              units={units}
              min={min}
              constraint={constraintLine(role)}
              // A hero tile is pinned to 12 columns but its HEIGHT is still the operator's.
              disabled={saving}
              stepPx={stepPx}
              onPreview={onPreview}
              onCommit={onResize}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

export function BoardGrid({
  biz,
  tiles,
  arranging,
  canEdit,
  saving,
  selected,
  onSelect,
  onReorder,
  onRemove,
  onResize,
}: {
  biz: string;
  tiles: BoardTile[];
  arranging: boolean;
  /** Only the owner may rearrange or remove — the engine's `is_mine`, not a guess here. */
  canEdit: boolean;
  saving: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onReorder: (tileIds: string[]) => void;
  onRemove: (tile: string) => void;
  onResize: (tile: string, units: TileUnits) => void;
}) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ id: string; units: TileUnits } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // One column plus one gap, in px. The MODEL is twelve columns even where the grid renders
  // six, so the step is measured against twelve — what is being edited is the stored span.
  const stepPx = React.useCallback(() => {
    const el = gridRef.current;
    if (!el) return 0;
    const gap = Number.parseFloat(getComputedStyle(el).columnGap) || 0;
    return (el.clientWidth - gap * (BOARD_COLUMNS - 1)) / BOARD_COLUMNS + gap;
  }, []);

  const unitsOf = React.useCallback(
    (tile: BoardTile): TileUnits => {
      const raw =
        preview?.id === tile.id
          ? preview.units
          : { width: tile.width_units, height: tile.height_units };
      return clampUnits(raw, roleOf(tile));
    },
    [preview],
  );

  const where = React.useMemo(
    () => placements(tiles.map((t) => unitsOf(t).width)),
    [unitsOf, tiles],
  );

  const onDragStart = ({ active }: DragStartEvent) => {
    setDragging(String(active.id));
    onSelect(String(active.id));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over || active.id === over.id) return;
    const ids = tiles.map((t) => t.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    onReorder(ids);
  };

  if (tiles.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            title="No widgets on this board yet"
            description="Add a measure to show it here. It shows the same figures as Explore."
          />
        </CardContent>
      </Card>
    );
  }

  const active = dragging ? tiles.find((t) => t.id === dragging) : undefined;

  const grid = (
    <div
      ref={gridRef}
      className="relative grid grid-cols-1 gap-5 md:grid-cols-6 xl:grid-cols-12"
      onClick={arranging ? () => onSelect(null) : undefined}
      onKeyDown={
        arranging
          ? (e) => {
              if (e.key === "Escape") onSelect(null);
            }
          : undefined
      }
    >
      {arranging && (dragging != null || preview != null) ? <ColumnGuides /> : null}
      {tiles.map((tile, i) => (
        <SortableTile
          key={tile.id}
          tile={tile}
          biz={biz}
          units={unitsOf(tile)}
          arranging={arranging}
          canEdit={canEdit}
          selected={selected === tile.id}
          saving={saving}
          row={where[i]?.row ?? 1}
          start={where[i]?.start ?? 1}
          stepPx={stepPx}
          onSelect={() => onSelect(tile.id)}
          onRemove={() => onRemove(tile.id)}
          onResize={(units) => onResize(tile.id, units)}
          onPreview={(units) => setPreview(units == null ? null : { id: tile.id, units })}
        />
      ))}
    </div>
  );

  return arranging ? (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToParentElement]}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <SortableContext items={tiles.map((t) => t.id)} strategy={rectSortingStrategy}>
        {grid}
      </SortableContext>
      <DragOverlay>
        {active ? (
          <div className="relative rotate-[-0.4deg]">
            <TileCard tile={active} biz={biz} selected={false} lifted chrome={null} />
            <span className="absolute -top-3 left-4 inline-flex h-6 items-center rounded-md bg-foreground px-2.5 text-xs text-background">
              Moving. Release to drop.
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  ) : (
    grid
  );
}
