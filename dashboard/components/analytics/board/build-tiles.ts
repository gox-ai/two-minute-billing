import type { ReportDashboard } from "@/lib/dashboards-api";
import {
  listMeasures,
  queryAnalytics,
  type AnalyticsMeasure,
  type AnalyticsQuery,
  type BatchEntry,
} from "@/lib/analytics-api";
import type { BoardTile } from "./board-grid";

/**
 * Every tile of one saved dashboard, answered — in ONE analytics batch.
 *
 * A tile stores a measure id (`report_dashboard_tiles.report_key`). A key the semantic layer
 * does not publish is not sent to the batch, which would answer 422 for it; the tile says so
 * instead. One request, not one per tile: a dozen widgets on a dozen requests would each
 * carry their own `as_of`, and a dozen instants do not reconcile.
 *
 * `range` is a DEFAULT — it fills in only what a tile has not pinned.
 *
 * A CUSTOM window (`start`/`end`, calendar dates) overrides the named range for the whole
 * board. The two are sent together nowhere: a query carrying both would leave which one
 * wins up to the engine, and the board would state a period it is not showing.
 */
export async function buildBoardTiles(
  dashboard: ReportDashboard,
  biz: string,
  defaults: { range?: string; granularity?: string; start?: string; end?: string } = {},
): Promise<{
  tiles: BoardTile[];
  measures: AnalyticsMeasure[];
  asOf: string | null;
  /** The window the engine actually answered over — a preset's dates are only knowable here. */
  resolved: { start: string; end: string } | null;
}> {
  const measures = await listMeasures();
  const measureIds = new Set(measures.map((m) => m.id));
  const measureTiles = dashboard.tiles.filter((t) => t.available && measureIds.has(t.report_key));

  const custom = defaults.start != null && defaults.end != null;

  const measureById = new Map(measures.map((m) => [m.id, m]));

  const queries: AnalyticsQuery[] = measureTiles.map((t) => ({
    key: t.id,
    measure: t.report_key,
    business: biz,
    // A custom window is the board's, so it beats a tile's own pinned range: the operator
    // asked for these dates and a tile quietly answering a different period would be the
    // one figure on the board nobody could reconcile.
    range: custom ? undefined : (t.range ?? defaults.range ?? "12m"),
    start: custom ? defaults.start : undefined,
    end: custom ? defaults.end : undefined,
    // A tile's own pin wins; the board-wide grain fills in for the rest. Without the
    // fallback `defaults.granularity` was accepted and silently ignored.
    grain: ((t.granularity ?? defaults.granularity) as AnalyticsQuery["grain"]) ?? undefined,
    split: t.group_by ?? undefined,
    currency: t.currency ?? undefined,
    shape: t.shape ?? undefined,
    segment: t.segment_id ?? undefined,
    // Every tile asks how it moved against the window before, where the measure has one to
    // compare. A figure without its direction is half an answer — and asking only where
    // discovery says `supports_compare` keeps one measure's refusal out of the whole batch.
    compare: measureById.get(t.report_key)?.supports_compare ? ("previous" as const) : undefined,
  }));

  let data: BatchEntry[] = [];
  let batchError: string | null = null;
  if (queries.length > 0) {
    const batch = await queryAnalytics({ queries, business: biz }).catch((e: Error) => e);
    if (batch instanceof Error) batchError = batch.message;
    else data = batch;
  }

  const byId = new Map(data.map((e) => [e.key, e]));

  const tiles: BoardTile[] = dashboard.tiles.map((t) => {
    const entry = byId.get(t.id);
    const isResult = entry != null && entry.object === "analytics_result";
    const unknown = t.available && !measureIds.has(t.report_key);
    return {
      id: t.id,
      report_key: t.report_key,
      name: t.name,
      available: t.available,
      range: t.range,
      currency: t.currency,
      group_by: t.group_by,
      granularity: t.granularity,
      shape: t.shape ?? null,
      segment_id: t.segment_id ?? null,
      range_overridden: custom && t.range != null,
      width_units: t.width_units,
      height_units: t.height_units,
      result: isResult ? entry : null,
      error: unknown
        ? `There is no measure called ${t.report_key}.`
        : entry && entry.object === "analytics_error"
          ? entry.error.message
          : batchError,
    };
  });

  const answered = tiles.find((t) => t.result != null)?.result ?? null;
  const asOf = answered?.as_of ?? null;
  const resolved = answered ? { start: answered.range.start, end: answered.range.end } : null;

  return { tiles, measures, asOf, resolved };
}
