// Saved report dashboards. Server-only, like `lib/api.ts` — it borrows that module's
// session-forwarding fetchers rather than opening a second way into the engine.
//
// The family is ORG-LEVEL with an optional `business` (mirroring `/v1/list_views`),
// because an org-level dashboard cannot live under `/v1/businesses/:biz/…`.

import { apiGet, apiGetOrNull, apiWrite } from "@/lib/api";
import type { ReportPayload } from "@/components/reports/report-format";

export type DashboardVisibility = "private" | "everyone";

/**
 * DEPRECATED (engine migration 0270) — four width presets, superseded by
 * `width_units`/`height_units`. Still returned by the engine, derived from the width; the
 * board does not read it.
 */
export type TileSize = "sm" | "md" | "lg" | "full";

export const TILE_SIZES: TileSize[] = ["sm", "md", "lg", "full"];

/** The board is twelve columns wide; a row is 80px tall. The engine checks both. */
export interface TileUnits {
  width: number;
  height: number;
}

/**
 * The previous period and how the figure moved, present on exactly the reports the
 * registry marks comparable.
 *
 * Typed here rather than in `lib/api.ts` (owned elsewhere) — delete this once
 * `ReportResult` carries it. `basis` is what makes the delta honest: a month-to-date
 * figure and a complete month are not the same measurement, so a tile LABELS its basis
 * instead of leaving the reader to assume one.
 */
export interface ReportComparison {
  prev_value: number | null;
  prev_label: string;
  /** Relative change in basis points. Null, never 0, where there is no base to divide by. */
  change_bps: number | null;
  basis:
    | "month_to_date"
    | "complete_month"
    | "period_to_date"
    | "complete_period"
    | "point_in_time";
}

/** A report answer as a tile receives it. */
export type TileReport = ReportPayload & { comparison?: ReportComparison };

/** One tile, WITHOUT its answer: a report key plus the options it pins. */
export interface DashboardTile {
  object: "report_dashboard_tile";
  id: string;
  report_key: string;
  /** The catalogue's name, or null once the key has left the catalogue. */
  name: string | null;
  available: boolean;
  range: string | null;
  currency: string | null;
  group_by: string | null;
  granularity: string | null;
  /** Null is `series`. Optional so an engine that predates it still type-checks. */
  shape?: "series" | "totals" | null;
  /** Null is the whole book. */
  segment_id?: string | null;
  /** DEPRECATED — read `width_units`. */
  size: TileSize;
  /** Columns of twelve. */
  width_units: number;
  /** Rows of 80px. */
  height_units: number;
  position: number;
}

export interface ReportDashboard {
  object: "report_dashboard";
  id: string;
  name: string;
  owner: string | null;
  /**
   * Whether the signed-in operator owns it — the engine's verdict, resolved from the
   * session. Only the owner may rename, re-share, default or delete, and the browser has
   * no reliable answer to "who am I", so this is never derived from an email held here.
   */
  is_mine: boolean;
  visibility: DashboardVisibility;
  is_default: boolean;
  /** False = an org-level dashboard, pointed at a business when it is opened. */
  business_scoped: boolean;
  tile_count: number;
  tiles: DashboardTile[];
  created_at: string;
  updated_at: string;
}

/**
 * A tile with its answer. Three states, two fields — see the module README:
 *  • `available` + `report`            — resolved.
 *  • `!available` + `error`            — the key has left the catalogue.
 *  • `available` + `report: null` + `error` — the report refused these options.
 */
export interface ResolvedTile extends DashboardTile {
  report: TileReport | null;
  error: string | null;
}

export interface ResolvedDashboard extends ReportDashboard {
  resolved_tiles: ResolvedTile[];
}

/** What a tile may pin. `null` clears an option; an absent key leaves it alone. */
export interface TileOptions {
  range?: string | null;
  currency?: string | null;
  group_by?: string | null;
  granularity?: string | null;
  /** Measure tiles only. `totals` pins a figure (no split) or a ranked list (split). */
  shape?: "series" | "totals" | null;
  /** A customer segment's id; null is the whole book. Refused together with `group_by`. */
  segment_id?: string | null;
  /** DEPRECATED — send `width_units`. */
  size?: TileSize;
  width_units?: number;
  height_units?: number;
}

/** Dashboard-wide defaults for a whole-dashboard fetch — they fill in only unpinned options. */
export interface DashboardDefaults {
  range?: string;
  currency?: string;
  granularity?: string;
}

export const listReportDashboards = (biz: string) =>
  apiGet<{ object: "list"; data: ReportDashboard[]; total: number }>(
    `/v1/report_dashboards?business=${encodeURIComponent(biz)}`,
  );

/**
 * The dashboard's metadata and tile ARRANGEMENT, unresolved — no figures. A board built on
 * the semantic layer resolves its own tiles through `queryAnalytics()` in one batch rather
 * than the per-tile old-catalogue resolver behind `getResolvedDashboard`, so it reads the
 * raw shape instead.
 */
export const getReportDashboard = (id: string) =>
  apiGetOrNull<ReportDashboard>(`/v1/report_dashboards/${encodeURIComponent(id)}`);

/**
 * The whole dashboard in ONE request — metadata plus every tile's report.
 *
 * Per-tile requests would each carry their own `as_of`, and figures measured at a dozen
 * different instants do not reconcile. 404 folds to null: a dashboard id goes stale when
 * someone else deletes it, and that is an absence rather than a failure.
 */
export function getResolvedDashboard(
  id: string,
  biz: string,
  defaults: DashboardDefaults = {},
): Promise<ResolvedDashboard | null> {
  const qs = new URLSearchParams({ business: biz });
  if (defaults.range) qs.set("range", defaults.range);
  if (defaults.currency) qs.set("currency", defaults.currency);
  if (defaults.granularity) qs.set("granularity", defaults.granularity);
  return apiGetOrNull<ResolvedDashboard>(
    `/v1/report_dashboards/${encodeURIComponent(id)}/reports?${qs.toString()}`,
  );
}

export const createReportDashboard = (body: {
  business?: string;
  name: string;
  visibility?: DashboardVisibility;
  is_default?: boolean;
  tiles?: Array<{ report_key: string } & TileOptions>;
}) => apiWrite("/v1/report_dashboards", body, "POST");

export const patchReportDashboard = (
  id: string,
  body: { name?: string; visibility?: DashboardVisibility; is_default?: boolean },
) => apiWrite(`/v1/report_dashboards/${encodeURIComponent(id)}`, body, "PATCH");

export const deleteReportDashboard = (id: string) =>
  apiWrite(`/v1/report_dashboards/${encodeURIComponent(id)}`, {}, "DELETE");

export const addDashboardTile = (id: string, body: { report_key: string } & TileOptions) =>
  apiWrite(`/v1/report_dashboards/${encodeURIComponent(id)}/tiles`, body, "POST");

export const patchDashboardTile = (id: string, tile: string, body: TileOptions) =>
  apiWrite(
    `/v1/report_dashboards/${encodeURIComponent(id)}/tiles/${encodeURIComponent(tile)}`,
    body,
    "PATCH",
  );

export const removeDashboardTile = (id: string, tile: string) =>
  apiWrite(
    `/v1/report_dashboards/${encodeURIComponent(id)}/tiles/${encodeURIComponent(tile)}`,
    {},
    "DELETE",
  );

/**
 * Reorder by naming EVERY tile exactly once, in the order wanted. A "move tile 3 to
 * index 1" call applied twice against a stale view produces an arrangement nobody asked
 * for; the engine refuses a list that does not match the dashboard it holds.
 */
export const reorderDashboardTiles = (id: string, tiles: string[]) =>
  apiWrite(`/v1/report_dashboards/${encodeURIComponent(id)}/tiles/reorder`, { tiles }, "POST");
