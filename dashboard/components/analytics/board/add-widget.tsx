"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SelectField } from "@/components/ui/select-field";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { dimensionLabel } from "@/components/reports/report-format";
import { useArranging, useDraftRebase } from "@/components/analytics/board/board-surface";
import { minWidth } from "@/components/analytics/board/span";
import type { MeasureTileRole } from "@/components/analytics/role";
import type { AnalyticsMeasure, AnswerShape } from "@/lib/analytics-api";
import type { Segment } from "@/lib/api/segments";

/** Starting widths, in columns of twelve. A tile is dragged from here, not chosen again. */
const WIDTH_OPTIONS = [
  { value: "3", label: "Quarter width" },
  { value: "6", label: "Half width" },
  { value: "9", label: "Three quarters" },
  { value: "12", label: "Full width" },
];

type Kind = "metric" | "breakdown" | "table";
type Layout = "chart" | "figure";

/**
 * The answer each choice asks the engine for, and so the role the tile will render as.
 * `shape: "totals"` drops the series — one figure without a split, one total per key with
 * one — which is what separates a ranked list from a period table.
 */
function planOf(kind: Kind, layout: Layout): { shape: AnswerShape; role: MeasureTileRole } {
  if (kind === "table") return { shape: "series", role: "hero" };
  if (kind === "breakdown") return { shape: "totals", role: "rows" };
  return layout === "figure"
    ? { shape: "totals", role: "figure" }
    : { shape: "series", role: "trend" };
}

const KIND_NOTE: Record<Kind, string> = {
  metric: "One measure over the board's period.",
  breakdown: "One measure split by a dimension, ranked by its total for the period.",
  table: "One measure split by a dimension, with a column for every period.",
};

/**
 * Building a board: choose what KIND of widget, which measure, how to split it, how wide.
 *
 * A PANEL rather than a modal — building a board is repetitive, and a dialog that closed on
 * every add turns "put six things on this" into six round trips. The full library (measures
 * AND the widgets only a page can render) lives at `/reports/stats`.
 *
 * Every choice reaches a stored field: `report_key`, `group_by`, `shape`, `width_units`.
 * The width options are the ones the board will KEEP — a tile is clamped to its role's floor
 * on render (`minWidth`), so offering a narrower start would be a choice it overrules.
 *
 * A SEGMENT scopes a Metric widget to one saved group of customers. It is offered only where
 * the engine answers it: never beside a split (refused), and only for measures discovery marks
 * `segmentable` — so choosing a segment narrows the measure list rather than letting you pick a
 * pair the engine would turn away on save.
 */
export function AddWidget({
  biz,
  measures,
  segments,
  onAdd,
}: {
  biz: string;
  measures: AnalyticsMeasure[];
  /** This business's saved segments, starters included. Empty hides the field. */
  segments: Segment[];
  onAdd: (tile: {
    report_key: string;
    width_units: number;
    range?: string;
    granularity?: string;
    group_by?: string;
    shape?: AnswerShape;
    segment_id?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<Kind>("metric");
  const [layout, setLayout] = React.useState<Layout>("chart");
  const [busy, setBusy] = React.useState(false);
  const [added, setAdded] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [measureId, setMeasureId] = React.useState("");
  const [dimension, setDimension] = React.useState("");
  /** `""` is the whole book. */
  const [segmentId, setSegmentId] = React.useState("");
  const [width, setWidth] = React.useState("6");
  // An add commits, so tell an arrangement in progress to rebase rather than retire.
  const rebase = useDraftRebase();
  // The page's primary action at rest; one of three controls in the edit band.
  const arranging = useArranging();

  const splits = kind !== "metric";
  const { shape, role } = planOf(kind, layout);
  const floor = minWidth(role);
  const widths = WIDTH_OPTIONS.filter((w) => Number(w.value) >= floor);

  // A split needs something to split BY, so those tabs offer only measures that publish a
  // dimension — otherwise you could pick a measure and then not be able to finish.
  const scoped = !splits && segmentId !== "";
  const pool = React.useMemo(
    () =>
      splits
        ? measures.filter((m) => m.dimensions.length > 0)
        : scoped
          ? measures.filter((m) => m.segmentable === true)
          : measures,
    [splits, scoped, measures],
  );
  // No measure the engine will scope means no segment field at all — an engine that predates
  // `segmentable` lands here, and so does a business with no saved segments.
  const canSegment = segments.length > 0 && measures.some((m) => m.segmentable === true);
  const unavailable = segments.filter((g) => g.answerable === false);
  const selected = pool.find((m) => m.id === measureId) ?? null;

  const options = React.useMemo(
    () =>
      pool.map((m) => ({
        value: m.id,
        label: m.name,
        keywords: m.id,
        hint: m.dimensions.length > 0 ? `${m.dimensions.length} splits` : undefined,
      })),
    [pool],
  );

  // The resets live in the events that cause them, not in an effect watching the result —
  // an effect would correct a stale measure, dimension or width one render late.
  const changeKind = (next: Kind) => {
    setKind(next);
    // A split cannot be scoped to a segment, so leaving Metric drops it.
    if (next !== "metric") setSegmentId("");
    if (next !== "metric" && !measures.some((m) => m.id === measureId && m.dimensions.length > 0)) {
      setMeasureId("");
      setDimension("");
    }
    const nextFloor = minWidth(planOf(next, layout).role);
    if (Number(width) < nextFloor) setWidth(String(nextFloor));
  };

  const changeSegment = (id: string) => {
    setSegmentId(id);
    if (id && !measures.some((m) => m.id === measureId && m.segmentable === true)) setMeasureId("");
  };

  const changeMeasure = (id: string) => {
    setMeasureId(id);
    const m = measures.find((x) => x.id === id);
    if (!m?.dimensions.includes(dimension)) setDimension("");
  };

  const ready = selected != null && (!splits || dimension !== "");

  const add = async () => {
    if (!selected || !ready) return;
    setBusy(true);
    setError(null);
    rebase();
    const res = await onAdd({
      report_key: selected.id,
      width_units: Math.max(Number(width), floor),
      range: "12m",
      // A totals answer has no periods to cut, so a grain on it would be a pin that means
      // nothing — and a tile that says "by month" over a single figure misleads.
      granularity: shape === "series" && selected.grains.includes("month") ? "month" : undefined,
      group_by: splits ? dimension : undefined,
      // Null on the tile is `series`, so only the departure from the default is sent.
      shape: shape === "totals" ? "totals" : undefined,
      segment_id: scoped ? segmentId : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "We could not add that measure.");
      return;
    }
    setAdded((prev) => [selected.name, ...prev].slice(0, 6));
  };

  const label = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant={arranging ? "outline" : "default"}
          className={arranging ? "bg-card" : undefined}
        >
          <Plus className="size-3.5" />
          Add widget
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add a widget</SheetTitle>
          <SheetDescription>
            The panel stays open, so you can add many widgets one after the other.{" "}
            {/* The library also lists the widgets a board cannot carry, so it is a link out
                rather than a second list in here. */}
            <Link
              href={`/businesses/${biz}/reports/stats`}
              className="font-medium text-primary hover:underline"
            >
              Browse all stats
            </Link>
            .
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
          <Tabs value={kind} onValueChange={(v) => changeKind(v as Kind)}>
            <TabsList>
              <TabsTrigger value="metric">Metric</TabsTrigger>
              <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
            {(["metric", "breakdown", "table"] as const).map((k) => (
              <TabsContent key={k} value={k}>
                <p className="text-xs text-muted-foreground">{KIND_NOTE[k]}</p>
              </TabsContent>
            ))}
          </Tabs>

          {canSegment && !splits ? (
            <div className="space-y-1.5">
              <span className={label}>Segment</span>
              <Combobox
                ariaLabel="Segment"
                options={[
                  { value: "", label: "All customers" },
                  ...segments.map((g) => ({
                    value: g.id,
                    label: g.name,
                    // Listed but not selectable: hiding it would leave the operator wondering
                    // where a starter went, and picking it would save a tile the engine refuses.
                    disabled: g.answerable === false,
                    hint:
                      g.answerable === false ? "unavailable" : g.is_starter ? "starter" : undefined,
                  })),
                ]}
                value={segmentId}
                onValueChange={changeSegment}
                placeholder="All customers"
                searchPlaceholder="Search segments"
                emptyMessage="No segment matches."
              />
              {scoped ? (
                <p className="text-xs text-muted-foreground">
                  The list below shows only the measures that a segment can answer.
                </p>
              ) : null}
              {/* Why a segment is unavailable HERE — the engine's own sentence, per segment,
                  because the reason is about this business's book, not the segment. */}
              {unavailable.length > 0 ? (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">
                    {unavailable.length} segment{unavailable.length === 1 ? " is" : "s are"}{" "}
                    unavailable for this business
                  </summary>
                  <ul className="mt-1.5 space-y-1.5">
                    {unavailable.map((g) => (
                      <li key={g.id}>
                        <span className="font-medium text-foreground">{g.name}</span>
                        {g.refusal ? `: ${g.refusal}` : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : canSegment && splits ? (
            <p className="text-xs text-muted-foreground">
              A breakdown or table covers every customer. You cannot limit a split to a segment yet.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <span className={label}>Measure</span>
            {/* A Combobox, not a Select: there are far more measures here than anyone will
                scroll, and the names share long prefixes. */}
            <Combobox
              ariaLabel="Measure"
              options={options}
              value={measureId}
              onValueChange={changeMeasure}
              placeholder="Select a measure"
              searchPlaceholder="Search measures"
              emptyMessage="No measure matches."
            />
            {selected?.description ? (
              <p className="text-xs text-muted-foreground">{selected.description}</p>
            ) : null}
          </div>

          {splits ? (
            <div className="space-y-1.5">
              <span className={label}>Split by</span>
              <SelectField
                ariaLabel="Dimension to split by"
                value={dimension}
                onValueChange={setDimension}
                disabled={selected == null}
                options={(selected?.dimensions ?? []).map((d) => ({
                  value: d,
                  label: dimensionLabel(d),
                }))}
              />
              {selected == null ? (
                <p className="text-xs text-muted-foreground">Select a measure first.</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1.5">
              <span className={label} id="widget-layout">
                Layout
              </span>
              {/* Two drawn choices rather than a dropdown: the difference is visual, so the
                  option shows it. "Figure only" asks for totals — no series is fetched. */}
              <div
                role="radiogroup"
                aria-labelledby="widget-layout"
                className="grid grid-cols-2 gap-2"
              >
                {(
                  [
                    { id: "chart", title: "With chart" },
                    { id: "figure", title: "Figure only" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={layout === o.id}
                    onClick={() => setLayout(o.id)}
                    className={cn(
                      "flex flex-col gap-2 rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent",
                      layout === o.id && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <span aria-hidden className="block h-1.5 w-12 rounded-full bg-muted" />
                    <span aria-hidden className="block h-2.5 w-16 rounded-full bg-muted" />
                    {o.id === "chart" ? (
                      <svg aria-hidden viewBox="0 0 80 20" className="h-5 w-full text-chart-1">
                        <path
                          d="M0 16 L16 13 L32 14 L48 8 L64 9 L80 3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <span aria-hidden className="block h-5" />
                    )}
                    <span className="text-xs">{o.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <span className={label}>Starting width</span>
            {widths.length > 1 ? (
              <>
                <SelectField
                  ariaLabel="Width for the new tile"
                  value={String(Math.max(Number(width), floor))}
                  onValueChange={setWidth}
                  options={widths}
                />
                <p className="text-xs text-muted-foreground">
                  After you add the tile, drag an edge to change its size.
                </p>
              </>
            ) : (
              // A period table is wide by construction and the board pins it to the full
              // row, so there is nothing to choose — say so rather than offer a choice.
              <p className="text-sm">
                Full width
                <span className="block text-xs text-muted-foreground">
                  A table has a column for every period, so it takes the whole row.
                </span>
              </p>
            )}
          </div>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <Button className="w-full" disabled={!ready || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add widget"}
          </Button>

          {added.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Added: <span className="text-foreground">{added.join(" · ")}</span>
            </p>
          ) : null}

          {measures.length === 0 ? (
            <p className="text-sm text-muted-foreground">No measures published yet.</p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
