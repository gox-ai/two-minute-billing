import { and, asc, count, eq, isNull, or, inArray, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { currentEventContext } from "@/platform/event-context";
import { createLogger } from "@/platform/logger";
import { businesses, reportDashboards, reportDashboardTiles } from "@db/schema";
import {
  PRESET_BY_PUBLIC_ID,
  PRESET_DASHBOARDS,
  presetPublicId,
  type PresetDashboard,
} from "./presets";
import { billingModelsPresent, type BillingModel } from "@/modules/metrics/billing-models";
import {
  REPORT_BY_KEY,
  GRANULARITIES,
  acceptsGranularity,
  type ReportDef,
} from "@/modules/metrics/reports/registry";
import { ANALYTICS_RANGES } from "@/modules/metrics/analytics";
import { resolveReport, ReportError, type ReportResult } from "@/modules/metrics/reports/resolve";
import { measureById, type MeasureDef } from "@/modules/metrics/daily/measures";
import {
  isAnalyticsWindow,
  ANALYTICS_WINDOWS,
  resolveAnalytics,
  resolveScope,
  GRAINS,
  ANSWER_SHAPES,
  type AnalyticsResult,
  type AnalyticsScope,
} from "@/modules/metrics/daily/public-query";
import { segmentRefusal } from "@/modules/metrics/daily/segment-series";
import { segmentPopulation, SegmentError } from "@/modules/segments/service";
import { MeasureRefused } from "@/modules/metrics/daily/query";

const log = createLogger("report-dashboards");

/**
 * Saved report dashboards. See `db/schema/report-dashboards.ts` for why this mirrors
 * `list_views` and why `business_id` is nullable.
 *
 * NOT evented and NOT ledgered, for the same reason a saved view is not: a dashboard is
 * how an operator looks at the figures, never a change to them, and no webhook
 * subscriber should react to someone arranging tiles.
 */
export class ReportDashboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDashboardError";
  }
}

/** A name already taken by one of this operator's dashboards, so the route answers 409. */
export class ReportDashboardNameTakenError extends ReportDashboardError {
  constructor(name: string) {
    super(`You already have a dashboard called '${name}'`);
    this.name = "ReportDashboardNameTakenError";
  }
}

export const DASHBOARD_VISIBILITY = ["private", "everyone"] as const;
export type DashboardVisibility = (typeof DASHBOARD_VISIBILITY)[number];

/**
 * DEPRECATED (0270) — four width presets, superseded by `width_units`/`height_units`.
 * Still accepted, and still stored, so a caller that has not moved keeps working.
 * Mirrored by `report_dashboard_tiles_size_check` in 0262.
 */
export const TILE_SIZES = ["sm", "md", "lg", "full"] as const;
export type TileSize = (typeof TILE_SIZES)[number];

/** The board is twelve columns wide; a row is 80px tall. Both mirrored by CHECKs in 0270. */
export const BOARD_COLUMNS = 12;
export const MIN_TILE_WIDTH_UNITS = 1;
export const MIN_TILE_HEIGHT_UNITS = 2;
export const MAX_TILE_HEIGHT_UNITS = 12;
export const DEFAULT_TILE_WIDTH_UNITS = 6;
export const DEFAULT_TILE_HEIGHT_UNITS = 4;

const WIDTH_OF_SIZE: Record<TileSize, number> = { sm: 3, md: 6, lg: 9, full: 12 };

/** The nearest surviving preset, so the deprecated column never contradicts the units. */
export function sizeOfWidthUnits(width: number): TileSize {
  if (width >= 11) return "full";
  if (width >= 8) return "lg";
  if (width >= 5) return "md";
  return "sm";
}

export function widthUnitsOfSize(size: TileSize): number {
  return WIDTH_OF_SIZE[size];
}

export const MAX_TILES_PER_DASHBOARD = 24;
/** Stored dashboards one person may own in one organization. Presets are not rows. */
export const MAX_DASHBOARDS_PER_OWNER = 50;
const DASHBOARD_COUNT_LOCK_NS = 7430;
const MAX_NAME_LENGTH = 60;

/**
 * How many tiles are resolved at once by a whole-dashboard fetch. Each tile is a full
 * report, so unbounded parallelism would put a dashboard's worth of heavy reads on the
 * pool at the same instant; one at a time would make a twelve-tile dashboard feel like
 * twelve page loads.
 */
const TILE_CONCURRENCY = 4;

export type ReportDashboardRow = typeof reportDashboards.$inferSelect;
export type ReportDashboardTileRow = typeof reportDashboardTiles.$inferSelect;

/**
 * Who is saving. No 'system' fallback: `owner` is the private-visibility key, so filing
 * an unattributable dashboard under a shared sentinel would make one caller's "private"
 * dashboard visible to every other caller that also had no actor. The same rule
 * `list_views` follows.
 */
export function resolveOwner(): string | null {
  return currentEventContext()?.actor ?? null;
}

export interface TileInput {
  reportKey: string;
  range?: string | null;
  currency?: string | null;
  groupBy?: string | null;
  granularity?: string | null;
  /** `series` | `totals` — measure tiles only. */
  shape?: string | null;
  /** A segment's public id — measure tiles only, and only a measure a segment can answer. */
  segmentId?: string | null;
  /** DEPRECATED — a width preset. Ignored when `widthUnits` is given. */
  size?: TileSize;
  widthUnits?: number;
  heightUnits?: number;
}

/**
 * The floor is not decoration: a tile dragged below it is a chart nobody can read, and
 * the browser is not the only writer — the API takes these too.
 */
function badUnits(tile: { widthUnits?: number; heightUnits?: number }): string | null {
  const w = tile.widthUnits;
  const h = tile.heightUnits;
  if (w !== undefined && (!Number.isInteger(w) || w < MIN_TILE_WIDTH_UNITS || w > BOARD_COLUMNS)) {
    return `width_units must be a whole number from ${MIN_TILE_WIDTH_UNITS} to ${BOARD_COLUMNS}.`;
  }
  if (
    h !== undefined &&
    (!Number.isInteger(h) || h < MIN_TILE_HEIGHT_UNITS || h > MAX_TILE_HEIGHT_UNITS)
  ) {
    return `height_units must be a whole number from ${MIN_TILE_HEIGHT_UNITS} to ${MAX_TILE_HEIGHT_UNITS}.`;
  }
  return null;
}

/**
 * Check one tile against the catalogue, BEFORE it is stored.
 *
 * A tile is saved once and opened for months, so this is the only moment the operator is
 * present to be told the combination is wrong. The checks mirror what `resolveReport`
 * would refuse, so a tile that saves is a tile that answers.
 *
 * Returns a caller-facing message, or null when the tile is usable.
 */
export function validateTile(tile: TileInput): string | null {
  const key = tile.reportKey?.trim();
  if (!key) return "A tile needs a report key.";
  if (tile.size && !TILE_SIZES.includes(tile.size)) return `Unknown tile size '${tile.size}'.`;
  const bad = badUnits(tile);
  if (bad) return bad;
  if (tile.currency && !/^[A-Z]{3}$/.test(tile.currency.toUpperCase())) {
    return `currency must be a three-letter code, or absent for every currency.`;
  }

  // A board tile is a report key from the OLD catalogue, or a measure id from the
  // semantic layer — the two namespaces coexist until Phase 4 finishes moving the
  // catalogue onto the resolver. Whichever it is, the fine-grained checks (range vocab,
  // grain, dimension) mirror what the ANSWERING endpoint would refuse, so a tile that
  // saves is a tile that answers.
  const measure = measureById(key);
  if (measure) return validateMeasureTile(tile, measure);

  const def = REPORT_BY_KEY.get(key);
  if (!def) return `No such report or measure: ${key}`;
  if (tile.shape) return `${def.name} is a report, and shape applies to measures only`;
  if (tile.segmentId) return `${def.name} is a report, and a segment applies to measures only`;
  if (tile.range && !ANALYTICS_RANGES.includes(tile.range as (typeof ANALYTICS_RANGES)[number])) {
    return `range must be one of: ${ANALYTICS_RANGES.join(", ")}`;
  }
  if (tile.granularity) {
    if (!GRANULARITIES.includes(tile.granularity as (typeof GRANULARITIES)[number])) {
      return `granularity must be one of: ${GRANULARITIES.join(", ")}`;
    }
    if (!acceptsGranularity(def)) {
      return `${def.name} has no series to re-cut, so granularity does not apply`;
    }
  }
  if (tile.groupBy && !def.dimensions.includes(tile.groupBy as "plan" | "currency")) {
    return def.dimensions.length === 0
      ? `${def.name} cannot be grouped`
      : `${def.name} can be grouped by: ${def.dimensions.join(", ")}`;
  }
  return null;
}

/** The same checks as above, against a semantic-layer measure's own declared vocabulary. */
function validateMeasureTile(tile: TileInput, measure: MeasureDef): string | null {
  if (tile.shape && !(ANSWER_SHAPES as readonly string[]).includes(tile.shape)) {
    return `shape must be one of: ${ANSWER_SHAPES.join(", ")}`;
  }
  if (tile.segmentId) {
    // Checked here so a tile that saves is a tile that answers; the segment's existence is
    // checked when it answers, because a segment can be deleted after the tile is saved.
    const why = segmentRefusal(measure, tile.groupBy ?? undefined, 1);
    if (why) return why;
  }
  if (tile.range && !isAnalyticsWindow(tile.range)) {
    return `range must be one of: ${ANALYTICS_WINDOWS.join(", ")}`;
  }
  if (
    tile.granularity &&
    !measure.grains.includes(tile.granularity as MeasureDef["grains"][number])
  ) {
    return `${measure.name} can be cut by: ${measure.grains.join(", ")}`;
  }
  if (
    tile.groupBy &&
    !measure.dimensions.includes(tile.groupBy as MeasureDef["dimensions"][number])
  ) {
    return measure.dimensions.length === 0
      ? `${measure.name} cannot be split`
      : `${measure.name} can be split by: ${measure.dimensions.join(", ")}`;
  }
  return null;
}

/** Normalize a tile's options to what the DB stores: absent, never "". */
function tileValues(tile: TileInput) {
  return {
    reportKey: tile.reportKey.trim(),
    range: tile.range || null,
    currency: tile.currency ? tile.currency.toUpperCase() : null,
    groupBy: tile.groupBy || null,
    granularity: tile.granularity || null,
    shape: tile.shape || null,
    segmentId: tile.segmentId || null,
    ...sizing(tile),
  };
}

/**
 * One size, stored three ways. `width_units`/`height_units` are the truth; `size` is
 * derived from the width so the deprecated column cannot disagree with it. A caller that
 * still sends only `size` gets the width that preset always meant.
 */
function sizing(tile: { size?: TileSize; widthUnits?: number; heightUnits?: number }) {
  const widthUnits =
    tile.widthUnits ?? (tile.size ? widthUnitsOfSize(tile.size) : DEFAULT_TILE_WIDTH_UNITS);
  return {
    widthUnits,
    heightUnits: tile.heightUnits ?? DEFAULT_TILE_HEIGHT_UNITS,
    size: sizeOfWidthUnits(widthUnits),
  };
}

/**
 * `viewer` is who is asking, so the response states `is_mine` rather than making the
 * client compare emails. "Who am I" is a question only the engine answers correctly —
 * the actor comes from the session, not from anything the browser sends — and only the
 * owner may rename, re-share, default or delete.
 */
export function serializeDashboard(
  d: ReportDashboardRow,
  tiles: ReportDashboardTileRow[],
  viewer: string | null,
) {
  return {
    object: "report_dashboard" as const,
    id: d.publicId,
    name: d.name,
    owner: d.owner,
    is_mine: viewer != null && d.owner === viewer,
    visibility: d.visibility,
    is_default: d.isDefault,
    /** NULL business = an org-level dashboard; the caller names a business when opening it. */
    business_scoped: d.businessId != null,
    tile_count: tiles.length,
    tiles: tiles.map((t) => serializeTile(t)),
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

/**
 * One tile, WITHOUT its answer.
 *
 * `available` is resolved from the registry on every read, not stored: a report key can
 * leave the catalogue long after the tile was saved. `name` is the catalogue's name when
 * the report still exists and null when it does not — the client renders the key so the
 * operator can see which tile has gone stale, which is the whole point of not dropping it.
 */
export function serializeTile(t: ReportDashboardTileRow, def?: ReportDef) {
  const d = def ?? REPORT_BY_KEY.get(t.reportKey);
  const measure = d ? undefined : measureById(t.reportKey);
  return {
    object: "report_dashboard_tile" as const,
    id: t.publicId,
    report_key: t.reportKey,
    name: d?.name ?? measure?.name ?? null,
    available: d != null || measure != null,
    range: t.range,
    currency: t.currency,
    group_by: t.groupBy,
    granularity: t.granularity,
    shape: t.shape,
    segment_id: t.segmentId,
    /** DEPRECATED — read `width_units`. */
    size: t.size,
    width_units: t.widthUnits,
    height_units: t.heightUnits,
    position: t.position,
  };
}

export interface DashboardInput {
  organizationId: string;
  businessId: string | null;
  name: string;
  visibility?: DashboardVisibility;
  isDefault?: boolean;
  tiles?: TileInput[];
  /** Overrides the ambient actor — for scripts and tests only. */
  owner?: string | null;
}

export async function createDashboard(
  input: DashboardInput,
): Promise<{ dashboard: ReportDashboardRow; tiles: ReportDashboardTileRow[] }> {
  const name = input.name?.trim();
  if (!name) throw new ReportDashboardError("A dashboard needs a name");
  if (name.length > MAX_NAME_LENGTH) {
    throw new ReportDashboardError(`A dashboard name may be at most ${MAX_NAME_LENGTH} characters`);
  }

  const visibility = input.visibility ?? "private";
  if (!DASHBOARD_VISIBILITY.includes(visibility)) {
    throw new ReportDashboardError(`Unknown visibility '${visibility}'`);
  }

  const owner = input.owner ?? resolveOwner();
  if (!owner) throw new ReportDashboardError("Cannot determine who owns this dashboard");

  const tiles = input.tiles ?? [];
  if (tiles.length > MAX_TILES_PER_DASHBOARD) {
    throw new ReportDashboardError(`A dashboard may hold at most ${MAX_TILES_PER_DASHBOARD} tiles`);
  }
  for (const t of tiles) {
    const problem = validateTile(t);
    if (problem) throw new ReportDashboardError(problem);
  }

  return withTenant(input.organizationId, async (tx) => {
    // Serialise this owner's creates so two parallel requests cannot both pass the count.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.organizationId}:${owner}`}::text, ${DASHBOARD_COUNT_LOCK_NS}))`,
    );
    const [held] = await tx
      .select({ n: count() })
      .from(reportDashboards)
      .where(
        and(
          eq(reportDashboards.organizationId, input.organizationId),
          eq(reportDashboards.owner, owner),
        ),
      );
    if ((held?.n ?? 0) >= MAX_DASHBOARDS_PER_OWNER) {
      throw new ReportDashboardError(
        `We could not create the dashboard. You have ${MAX_DASHBOARDS_PER_OWNER} dashboards, which is the maximum. Delete a dashboard, then try again.`,
      );
    }
    if (input.isDefault) await clearDefault(tx, input, owner);
    let dashboard: ReportDashboardRow;
    try {
      const [row] = await tx
        .insert(reportDashboards)
        .values({
          organizationId: input.organizationId,
          businessId: input.businessId,
          publicId: publicId("dash"),
          name,
          owner,
          visibility,
          isDefault: input.isDefault ?? false,
        })
        .returning();
      dashboard = row!;
    } catch (e) {
      throw nameConflict(e, name);
    }
    const inserted = tiles.length
      ? await tx
          .insert(reportDashboardTiles)
          .values(
            tiles.map((t, i) => ({
              organizationId: input.organizationId,
              dashboardId: dashboard.id,
              publicId: publicId("dtile"),
              position: i,
              ...tileValues(t),
            })),
          )
          .returning()
      : [];
    return { dashboard, tiles: inserted };
  });
}

/**
 * Clear this operator's existing default, so `report_dashboards_default_uq` sees one row
 * at a time. In the same transaction as the write that sets the new one — two statements
 * outside one would leave the operator with no default if the second failed.
 */
async function clearDefault(
  tx: Tx,
  scope: { businessId: string | null },
  owner: string,
): Promise<void> {
  await tx
    .update(reportDashboards)
    .set({ isDefault: false })
    .where(
      and(
        scope.businessId == null
          ? isNull(reportDashboards.businessId)
          : eq(reportDashboards.businessId, scope.businessId),
        eq(reportDashboards.owner, owner),
        eq(reportDashboards.isDefault, true),
      ),
    );
}

/**
 * Postgres 23505 on the name index → a typed conflict; anything else re-thrown.
 *
 * Drizzle wraps the driver error, so `code` lives on `.cause`; and postgres-js names the
 * field `constraint_name` where node-postgres uses `constraint`. Missing either turns a
 * fixable "you already have a dashboard by that name" into a 500 with a SQL dump. Same
 * shape as `list-views/service.ts`, which is where that was learnt.
 */
function nameConflict(e: unknown, name: string): unknown {
  type PgError = { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
  for (
    let cur: unknown = e, depth = 0;
    cur != null && depth < 4;
    cur = (cur as PgError).cause, depth++
  ) {
    const err = cur as PgError;
    if (err.code !== "23505") continue;
    const constraint = err.constraint ?? err.constraint_name;
    // A 23505 with no constraint name can only be this insert's name index: the public id
    // is minted, not supplied.
    if (constraint == null || constraint === "report_dashboards_name_uq") {
      return new ReportDashboardNameTakenError(name);
    }
  }
  return e;
}

/**
 * Dashboards visible to one operator in one scope: their own, plus everything the
 * organization shares. `businessId` null reads the org-level dashboards.
 *
 * Not paginated, for the same reason saved views are not: an operator keeps a handful.
 */
export async function listDashboards(
  organizationId: string,
  businessId: string | null,
  owner: string | null,
): Promise<Array<{ dashboard: ReportDashboardRow; tiles: ReportDashboardTileRow[] }>> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select()
      .from(reportDashboards)
      .where(
        and(
          // `= NULL` is never true, so the org-level case needs IS NULL — otherwise every
          // org-level scope reads as empty.
          businessId == null
            ? isNull(reportDashboards.businessId)
            : eq(reportDashboards.businessId, businessId),
          owner == null
            ? eq(reportDashboards.visibility, "everyone")
            : or(eq(reportDashboards.owner, owner), eq(reportDashboards.visibility, "everyone")),
        ),
      )
      .orderBy(asc(reportDashboards.name));
    // The built-in five lead, in their declared order, then the operator's own by name. A
    // preset is not a row, so it cannot be ordered by the query that fetched the rows.
    const models = businessId == null ? null : await billingModelsPresent(tx, businessId);
    const presets = listPresets(organizationId, businessId, models);
    if (rows.length === 0) return presets;
    // One query for every dashboard's tiles: a per-row read would be N+1 on the one screen
    // that shows all of them.
    const tiles = await tx
      .select()
      .from(reportDashboardTiles)
      .where(
        inArray(
          reportDashboardTiles.dashboardId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(reportDashboardTiles.position), asc(reportDashboardTiles.createdAt));
    return [
      ...presets,
      ...rows.map((dashboard) => ({
        dashboard,
        tiles: tiles.filter((t) => t.dashboardId === dashboard.id),
      })),
    ];
  });
}

/**
 * A preset, in the shape the rest of this module already speaks.
 *
 * Synthesising rows rather than teaching `serializeDashboard` and `resolveDashboard` about a
 * second kind of dashboard is the whole point: every reader downstream — the serializer, the
 * tile resolver, the CSV, the UI — keeps ONE code path, so a preset cannot render differently
 * from a saved dashboard or drift from it as either changes.
 *
 * `owner` is the empty string, which is what makes a preset read-only for free: every write
 * checks `row.owner === owner` and `resolveOwner()` never returns `""`, so nobody owns a
 * preset and no write can pass. It is also why `is_mine` comes out false.
 */
const PRESET_EPOCH = new Date(0);

function presetAsRows(
  preset: PresetDashboard,
  organizationId: string,
  businessId: string | null,
): { dashboard: ReportDashboardRow; tiles: ReportDashboardTileRow[] } {
  const dashboard: ReportDashboardRow = {
    id: `preset:${preset.key}`,
    organizationId,
    businessId,
    publicId: presetPublicId(preset.key),
    name: preset.name,
    owner: "",
    visibility: "everyone",
    isDefault: false,
    createdAt: PRESET_EPOCH,
    updatedAt: PRESET_EPOCH,
    resourceVersion: 1,
  };
  const tiles: ReportDashboardTileRow[] = preset.tiles.map((t, i) => ({
    id: `preset:${preset.key}:${i}`,
    organizationId,
    dashboardId: dashboard.id,
    publicId: `dtile_preset_${preset.key}_${i}`,
    reportKey: t.report,
    range: t.range ?? null,
    currency: null,
    groupBy: t.groupBy ?? null,
    granularity: t.granularity ?? null,
    shape: t.shape ?? null,
    segmentId: null,
    ...sizing({ size: t.size, heightUnits: t.heightUnits }),
    position: i,
    createdAt: PRESET_EPOCH,
    updatedAt: PRESET_EPOCH,
    resourceVersion: 1,
  }));
  return { dashboard, tiles };
}

/** The five built-in dashboards, for this scope. */
export function listPresets(
  organizationId: string,
  businessId: string | null,
  /** The business's models; a preset for a model it does not have is left out. Null: all. */
  models: ReadonlySet<BillingModel> | null = null,
): Array<{ dashboard: ReportDashboardRow; tiles: ReportDashboardTileRow[] }> {
  const listed = PRESET_DASHBOARDS.filter((p) => !p.requires || !models || models.has(p.requires));
  // No subscriptions: the page opens on the first preset, so lead with this business's models.
  const modelFirst = models != null && !models.has("subscriptions");
  const ordered = modelFirst
    ? [...listed.filter((p) => p.requires), ...listed.filter((p) => !p.requires)]
    : listed;
  return ordered.map((p) => presetAsRows(p, organizationId, businessId));
}

/** A preset by its public id, or null when the id is not one. */
export function findPreset(
  publicId: string,
  organizationId: string,
  businessId: string | null,
): { dashboard: ReportDashboardRow; tiles: ReportDashboardTileRow[] } | null {
  const preset = PRESET_BY_PUBLIC_ID.get(publicId);
  return preset ? presetAsRows(preset, organizationId, businessId) : null;
}

export const isPresetId = (publicId: string) => PRESET_BY_PUBLIC_ID.has(publicId);

/**
 * A preset is not editable, and says so.
 *
 * Every write below looks the dashboard up in the table, so a preset id would simply not be
 * found and the caller would get "no such dashboard" — technically safe, and misleading:
 * the dashboard is right there on their screen. `owner: ""` already makes a preset
 * unownable, so this is about the MESSAGE, not the protection.
 */
function refusePresetWrite(dashboardPublicId: string): void {
  if (isPresetId(dashboardPublicId)) {
    throw new ReportDashboardError(
      "This is a built-in dashboard and cannot be changed. Create one of your own to customize it.",
    );
  }
}

async function tilesOf(tx: Tx, dashboardId: string): Promise<ReportDashboardTileRow[]> {
  return (
    tx
      .select()
      .from(reportDashboardTiles)
      .where(eq(reportDashboardTiles.dashboardId, dashboardId))
      // `created_at` breaks position ties: positions are rewritten wholesale on reorder and
      // are not unique, so without a tiebreak two tiles could swap between two reads.
      .orderBy(asc(reportDashboardTiles.position), asc(reportDashboardTiles.createdAt))
  );
}

/** Visible to this operator: their own, or shared with the organization. */
function visibleTo(owner: string | null) {
  return owner == null
    ? eq(reportDashboards.visibility, "everyone")
    : or(eq(reportDashboards.owner, owner), eq(reportDashboards.visibility, "everyone"));
}

/**
 * One dashboard and its tiles, or null when this operator cannot see it.
 *
 * "No such dashboard" and "not visible to you" are one answer on purpose: distinguishing
 * them would tell one operator that another holds a private dashboard by that id.
 */
export async function getDashboard(
  organizationId: string,
  dashboardPublicId: string,
  owner: string | null,
): Promise<{ dashboard: ReportDashboardRow; tiles: ReportDashboardTileRow[] } | null> {
  // A preset needs no query, and must answer even for an operator with no saved dashboards.
  const preset = findPreset(dashboardPublicId, organizationId, null);
  if (preset) return preset;
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(reportDashboards)
      .where(and(eq(reportDashboards.publicId, dashboardPublicId), visibleTo(owner)))
      .limit(1);
    if (!row) return null;
    return { dashboard: row, tiles: await tilesOf(tx, row.id) };
  });
}

export interface DashboardPatch {
  name?: string;
  visibility?: DashboardVisibility;
  isDefault?: boolean;
}

/**
 * Rename, re-share or default a dashboard. Returns null when no dashboard with this id is
 * EDITABLE by this operator.
 *
 * Owner-only, including for a shared dashboard: one the whole team has come to rely on
 * must not be silently redefined by whoever opened it last.
 */
export async function updateDashboard(
  organizationId: string,
  dashboardPublicId: string,
  owner: string | null,
  patch: DashboardPatch,
): Promise<{ dashboard: ReportDashboardRow; tiles: ReportDashboardTileRow[] } | null> {
  refusePresetWrite(dashboardPublicId);
  if (!owner) throw new ReportDashboardError("Cannot determine who owns this dashboard");
  const name = patch.name?.trim();
  if (patch.name != null && !name) throw new ReportDashboardError("A dashboard needs a name");
  if (name && name.length > MAX_NAME_LENGTH) {
    throw new ReportDashboardError(`A dashboard name may be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (patch.visibility && !DASHBOARD_VISIBILITY.includes(patch.visibility)) {
    throw new ReportDashboardError(`Unknown visibility '${patch.visibility}'`);
  }

  return withTenant(organizationId, async (tx) => {
    const existing = await ownedDashboard(tx, dashboardPublicId, owner);
    if (!existing) return null;
    if (patch.isDefault) await clearDefault(tx, existing, owner);
    let row: ReportDashboardRow;
    try {
      const [updated] = await tx
        .update(reportDashboards)
        // `updated_at`/`resource_version` come from the bump_row_version trigger. Each
        // field applies only when present, so a rename cannot clear a visibility.
        .set({
          ...(name ? { name } : {}),
          ...(patch.visibility ? { visibility: patch.visibility } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        })
        .where(eq(reportDashboards.id, existing.id))
        .returning();
      row = updated!;
    } catch (e) {
      throw nameConflict(e, name ?? existing.name);
    }
    return { dashboard: row, tiles: await tilesOf(tx, row.id) };
  });
}

/** The dashboard this operator OWNS, for the write paths. Null covers gone and not-yours. */
async function ownedDashboard(
  tx: Tx,
  dashboardPublicId: string,
  owner: string,
): Promise<ReportDashboardRow | null> {
  const [row] = await tx
    .select()
    .from(reportDashboards)
    .where(and(eq(reportDashboards.publicId, dashboardPublicId), eq(reportDashboards.owner, owner)))
    .limit(1);
  return row ?? null;
}

/**
 * Hard-delete a dashboard and its tiles. Safe to delete for real, like a saved view and
 * unlike every financial record here: a dashboard posts nothing and reverses nothing.
 */
export async function deleteDashboard(
  organizationId: string,
  dashboardPublicId: string,
  owner: string | null,
): Promise<boolean> {
  refusePresetWrite(dashboardPublicId);
  if (!owner) throw new ReportDashboardError("Cannot determine who owns this dashboard");
  return withTenant(organizationId, async (tx) => {
    // The tiles go with it through `dashboard_id … ON DELETE CASCADE`.
    const deleted = await tx
      .delete(reportDashboards)
      .where(
        and(eq(reportDashboards.publicId, dashboardPublicId), eq(reportDashboards.owner, owner)),
      )
      .returning({ id: reportDashboards.id });
    log.log("report dashboard deleted", {
      dashboard: dashboardPublicId,
      found: deleted.length > 0,
    });
    return deleted.length > 0;
  });
}

/** Append a tile. Returns null when the dashboard is gone or not this operator's. */
export async function addTile(
  organizationId: string,
  dashboardPublicId: string,
  owner: string | null,
  tile: TileInput,
): Promise<ReportDashboardTileRow | null> {
  refusePresetWrite(dashboardPublicId);
  if (!owner) throw new ReportDashboardError("Cannot determine who owns this dashboard");
  const problem = validateTile(tile);
  if (problem) throw new ReportDashboardError(problem);
  return withTenant(organizationId, async (tx) => {
    const dashboard = await ownedDashboard(tx, dashboardPublicId, owner);
    if (!dashboard) return null;
    if (tile.segmentId) {
      await refuseUnresolvableSegment(organizationId, dashboard.businessId, tile.segmentId);
    }
    const existing = await tilesOf(tx, dashboard.id);
    if (existing.length >= MAX_TILES_PER_DASHBOARD) {
      throw new ReportDashboardError(
        `A dashboard may hold at most ${MAX_TILES_PER_DASHBOARD} tiles`,
      );
    }
    const [row] = await tx
      .insert(reportDashboardTiles)
      .values({
        organizationId,
        dashboardId: dashboard.id,
        publicId: publicId("dtile"),
        position: existing.length ? existing[existing.length - 1]!.position + 1 : 0,
        ...tileValues(tile),
      })
      .returning();
    return row!;
  });
}

/**
 * A segment tile must be answerable when it is SAVED, not only when it is read — otherwise a
 * segment that cannot resolve on this business (an unpinned `mrr` threshold on a
 * multi-currency book) saves fine and reads "could not be answered" forever. It is still checked
 * on read, because a segment can be deleted after the tile is saved.
 */
async function refuseUnresolvableSegment(
  organizationId: string,
  businessId: string | null,
  segmentId: string,
): Promise<void> {
  if (!businessId) {
    throw new ReportDashboardError(
      "A segment belongs to one business, and this dashboard is org-level. Put the tile on a business dashboard.",
    );
  }
  try {
    await segmentPopulation(organizationId, businessId, segmentId);
  } catch (e) {
    if (e instanceof SegmentError) throw new ReportDashboardError(e.message);
    throw e;
  }
}

export interface TilePatch {
  range?: string | null;
  currency?: string | null;
  groupBy?: string | null;
  granularity?: string | null;
  shape?: string | null;
  segmentId?: string | null;
  /** DEPRECATED — a width preset. Ignored when `widthUnits` is given. */
  size?: TileSize;
  widthUnits?: number;
  heightUnits?: number;
}

/**
 * Re-point a tile's options. The report key is NOT patchable: "show a different report
 * here" is a different tile, and allowing it would let a tile's saved options survive a
 * change of report that no longer accepts them.
 */
export async function updateTile(
  organizationId: string,
  dashboardPublicId: string,
  tilePublicId: string,
  owner: string | null,
  patch: TilePatch,
): Promise<ReportDashboardTileRow | null> {
  refusePresetWrite(dashboardPublicId);
  if (!owner) throw new ReportDashboardError("Cannot determine who owns this dashboard");
  return withTenant(organizationId, async (tx) => {
    const dashboard = await ownedDashboard(tx, dashboardPublicId, owner);
    if (!dashboard) return null;
    const [existing] = await tx
      .select()
      .from(reportDashboardTiles)
      .where(
        and(
          eq(reportDashboardTiles.publicId, tilePublicId),
          eq(reportDashboardTiles.dashboardId, dashboard.id),
        ),
      )
      .limit(1);
    if (!existing) return null;

    // Validated as the tile WOULD BE, not as the patch arrived: a patch that only changes
    // the range must still be checked against the granularity the tile already carries.
    const merged: TileInput = {
      reportKey: existing.reportKey,
      range: patch.range !== undefined ? patch.range : existing.range,
      currency: patch.currency !== undefined ? patch.currency : existing.currency,
      groupBy: patch.groupBy !== undefined ? patch.groupBy : existing.groupBy,
      granularity: patch.granularity !== undefined ? patch.granularity : existing.granularity,
      shape: patch.shape !== undefined ? patch.shape : existing.shape,
      segmentId: patch.segmentId !== undefined ? patch.segmentId : existing.segmentId,
      size: patch.size ?? (existing.size as TileSize),
      // A `size`-only patch is still a width change — the preset is what it always meant.
      widthUnits:
        patch.widthUnits ?? (patch.size ? widthUnitsOfSize(patch.size) : existing.widthUnits),
      heightUnits: patch.heightUnits ?? existing.heightUnits,
    };
    const problem = validateTile(merged);
    if (problem) throw new ReportDashboardError(problem);
    if (patch.segmentId && merged.segmentId) {
      await refuseUnresolvableSegment(organizationId, dashboard.businessId, merged.segmentId);
    }

    const [row] = await tx
      .update(reportDashboardTiles)
      .set({
        ...(patch.range !== undefined ? { range: merged.range ?? null } : {}),
        ...(patch.currency !== undefined ? { currency: merged.currency ?? null } : {}),
        ...(patch.groupBy !== undefined ? { groupBy: merged.groupBy ?? null } : {}),
        ...(patch.granularity !== undefined ? { granularity: merged.granularity ?? null } : {}),
        ...(patch.shape !== undefined ? { shape: merged.shape || null } : {}),
        ...(patch.segmentId !== undefined ? { segmentId: merged.segmentId || null } : {}),
        // A size change of any kind rewrites all three, so `size` cannot drift from the units.
        ...(patch.size !== undefined || patch.widthUnits !== undefined
          ? { widthUnits: merged.widthUnits, size: sizeOfWidthUnits(merged.widthUnits!) }
          : {}),
        ...(patch.heightUnits !== undefined ? { heightUnits: merged.heightUnits } : {}),
      })
      .where(eq(reportDashboardTiles.id, existing.id))
      .returning();
    return row ?? null;
  });
}

/** Remove a tile. False when the dashboard or the tile is gone, or not this operator's. */
export async function removeTile(
  organizationId: string,
  dashboardPublicId: string,
  tilePublicId: string,
  owner: string | null,
): Promise<boolean> {
  refusePresetWrite(dashboardPublicId);
  if (!owner) throw new ReportDashboardError("Cannot determine who owns this dashboard");
  return withTenant(organizationId, async (tx) => {
    const dashboard = await ownedDashboard(tx, dashboardPublicId, owner);
    if (!dashboard) return false;
    const deleted = await tx
      .delete(reportDashboardTiles)
      .where(
        and(
          eq(reportDashboardTiles.publicId, tilePublicId),
          eq(reportDashboardTiles.dashboardId, dashboard.id),
        ),
      )
      .returning({ id: reportDashboardTiles.id });
    return deleted.length > 0;
  });
}

/**
 * Reorder by naming the tiles in the order wanted — the WHOLE list, not a move.
 *
 * A full list is what a drag-and-drop UI already has, and it cannot express a half-applied
 * order: "move tile 3 to index 1" repeated twice on a stale view produces an arrangement
 * neither operator asked for. The order must name every tile exactly once, so a request
 * built from a stale dashboard is refused rather than silently dropping a tile to the end.
 */
export async function reorderTiles(
  organizationId: string,
  dashboardPublicId: string,
  owner: string | null,
  tilePublicIds: string[],
): Promise<ReportDashboardTileRow[] | null> {
  refusePresetWrite(dashboardPublicId);
  if (!owner) throw new ReportDashboardError("Cannot determine who owns this dashboard");
  return withTenant(organizationId, async (tx) => {
    const dashboard = await ownedDashboard(tx, dashboardPublicId, owner);
    if (!dashboard) return null;
    const existing = await tilesOf(tx, dashboard.id);
    const have = new Set(existing.map((t) => t.publicId));
    const want = new Set(tilePublicIds);
    if (want.size !== tilePublicIds.length) {
      throw new ReportDashboardError("A tile order may not name the same tile twice");
    }
    if (want.size !== have.size || [...want].some((id) => !have.has(id))) {
      throw new ReportDashboardError(
        "A tile order must name every tile on this dashboard exactly once",
      );
    }
    for (const [i, id] of tilePublicIds.entries()) {
      await tx
        .update(reportDashboardTiles)
        .set({ position: i })
        .where(
          and(
            eq(reportDashboardTiles.publicId, id),
            eq(reportDashboardTiles.dashboardId, dashboard.id),
          ),
        );
    }
    return tilesOf(tx, dashboard.id);
  });
}

/**
 * One tile, WITH its answer — the shape the whole-dashboard fetch returns.
 *
 * Four states, three fields, and none of them is "blank":
 *   • `available: true`  + `result` — a semantic-layer MEASURE answered.
 *   • `available: true`  + `report` — an old-catalogue report answered.
 *   • `available: false` + `error`  — the key is neither. The tile still appears, still
 *     names its key, and says so. Dropping it would quietly change what a named dashboard
 *     means.
 *   • `available: true`  + `error`  — it exists but refused these options (a dimension it
 *     does not offer, say). One tile's failure is not the dashboard's.
 */
export interface ResolvedTile extends ReturnType<typeof serializeTile> {
  report: ReportResult | null;
  result: AnalyticsResult | null;
  error: string | null;
}

/** The analytics scope for the business a dashboard is being answered for. */
async function loadAnalyticsScope(
  organizationId: string,
  businessId: string,
): Promise<AnalyticsScope | null> {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: businesses.id,
        publicId: businesses.publicId,
        name: businesses.name,
        timezone: businesses.timezone,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  return row ? resolveScope(organizationId, row) : null;
}

/**
 * A tile naming a semantic-layer measure, answered by the same resolver `/v1/analytics` uses.
 *
 * A dashboard-wide default that this measure cannot honour is DROPPED — the tile never asked
 * for it. The tile's own pins are passed through and the resolver's refusal is reported, for
 * the reason the report path gives below: a pin the client prints must not be ignored.
 */
async function answerMeasureTile(
  tile: ReportDashboardTileRow,
  measure: MeasureDef,
  scope: AnalyticsScope | null,
  defaults: { range?: string; currency?: string; granularity?: string; now?: Date },
): Promise<ResolvedTile> {
  const base = { ...serializeTile(tile), report: null } as const;
  if (!scope) {
    return { ...base, result: null, error: "No such business to answer for." };
  }
  const defaultRange = isAnalyticsWindow(defaults.range) ? defaults.range : undefined;
  const defaultGrain =
    defaults.granularity != null &&
    (GRAINS as readonly string[]).includes(defaults.granularity) &&
    measure.grains.includes(defaults.granularity as MeasureDef["grains"][number])
      ? defaults.granularity
      : undefined;
  try {
    const result = await resolveAnalytics(
      scope,
      {
        measure: measure.id,
        range: tile.range ?? defaultRange,
        grain: tile.granularity ?? defaultGrain,
        split: tile.groupBy ?? undefined,
        currency: tile.currency ?? defaults.currency,
        shape: tile.shape ?? undefined,
        segment: tile.segmentId ?? undefined,
      },
      defaults.now,
    );
    return { ...base, result, error: null };
  } catch (e) {
    if (e instanceof MeasureRefused) return { ...base, result: null, error: e.message };
    throw e;
  }
}

/**
 * A whole dashboard, resolved: metadata, plus every tile's report answer in ONE request.
 *
 * `businessId` is the business to answer FOR. A business-scoped dashboard answers for its
 * own; an org-level one (NULL business) has no business of its own and the caller must
 * name one — that is what makes an org-level dashboard a reusable layout rather than a
 * dashboard with a missing field.
 *
 * `defaults` fill in what a tile did not pin, so "this dashboard, in EUR" is one query
 * parameter rather than a rewrite of every tile.
 *
 * A tile names a semantic-layer measure or an old-catalogue report; each is answered by its
 * own resolver, so a measure tile is never reported as a report that has gone away.
 */
export async function resolveDashboard(
  organizationId: string,
  businessId: string,
  dashboardPublicId: string,
  owner: string | null,
  defaults: { range?: string; currency?: string; granularity?: string; now?: Date } = {},
): Promise<{
  dashboard: ReportDashboardRow;
  tiles: ReportDashboardTileRow[];
  resolved: ResolvedTile[];
} | null> {
  const found = await getDashboard(organizationId, dashboardPublicId, owner);
  if (!found) return null;

  const resolved: ResolvedTile[] = new Array(found.tiles.length);
  // Loaded once, and only if a measure tile needs it.
  let scope: Promise<AnalyticsScope | null> | null = null;
  const analyticsScope = () => (scope ??= loadAnalyticsScope(organizationId, businessId));

  const answer = async (i: number) => {
    const tile = found.tiles[i]!;
    const def = REPORT_BY_KEY.get(tile.reportKey);
    if (!def) {
      const measure = measureById(tile.reportKey);
      if (measure) {
        resolved[i] = await answerMeasureTile(tile, measure, await analyticsScope(), defaults);
        return;
      }
      resolved[i] = {
        ...serializeTile(tile),
        report: null,
        result: null,
        error: "This report is no longer available.",
      };
      return;
    }
    /**
     * A tile's OWN pin and a dashboard-wide default are not the same claim.
     *
     * Dropping a dashboard-wide granularity for a report that cannot be re-cut is right —
     * the tile never asked for it. Dropping the tile's own pinned one is not: the tile still
     * CARRIES that value, a client prints it ("Pinned: cut by day"), and the table underneath
     * was never re-cut. That is the silent-honouring this layer refuses everywhere else —
     * `/reports/:key` answers 400 rather than ignore it. Writes already refuse the
     * combination, so a tile can only reach this state by outliving a registry change (or a
     * direct insert), which is exactly when it must say so instead of quietly reading fine.
     */
    if (tile.granularity != null && !acceptsGranularity(def)) {
      resolved[i] = {
        ...serializeTile(tile, def),
        report: null,
        result: null,
        error: `${def.name} has no series to re-cut, so it cannot be shown by ${tile.granularity}. Remove the granularity from this tile.`,
      };
      return;
    }
    try {
      const report = await resolveReport(organizationId, businessId, tile.reportKey, {
        range: tile.range ?? defaults.range,
        currency: tile.currency ?? defaults.currency,
        // Only the dashboard-wide default is dropped here; the tile's own pin was handled
        // above, because dropping it would make the tile's label a lie.
        granularity: acceptsGranularity(def)
          ? (tile.granularity ?? defaults.granularity)
          : undefined,
        groupBy: tile.groupBy ?? undefined,
        now: defaults.now,
      });
      resolved[i] = { ...serializeTile(tile, def), report, result: null, error: null };
    } catch (e) {
      // A refused combination is this tile's problem. The rest of the dashboard still
      // answers, and the tile says why instead of showing an empty chart.
      if (e instanceof ReportError) {
        resolved[i] = { ...serializeTile(tile, def), report: null, result: null, error: e.message };
        return;
      }
      throw e;
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(TILE_CONCURRENCY, found.tiles.length) }, async () => {
      while (next < found.tiles.length) await answer(next++);
    }),
  );

  return { ...found, resolved };
}
