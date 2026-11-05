import Link from "next/link";
import { Download } from "lucide-react";
import { listBusinesses } from "@/lib/api";
import { listReportDashboards } from "@/lib/dashboards-api";
import { getSyncedAt } from "@/lib/analytics-api";
import { SyncedBadge } from "@/components/analytics/synced-badge";
import { listSegments, type Segment } from "@/lib/api/segments";
import type { DashboardVisibility, ReportDashboard } from "@/lib/dashboards-api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/format";
import { EXPLORE_RANGES } from "@/components/analytics/cut-options";
import { BoardTabs } from "@/components/analytics/board/board-tabs";
import { PeriodPicker } from "@/components/analytics/board/period-picker";
import { GrainControl } from "@/components/analytics/board/grain-control";
import { buildBoardTiles } from "@/components/analytics/board/build-tiles";
import { BoardSurface } from "@/components/analytics/board/board-surface";
import { clampUnits, type TileUnits } from "@/components/analytics/board/span";
import { roleOfResult } from "@/components/analytics/role";
import { BoardSkeleton } from "@/components/analytics/board/skeletons";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { AddWidget } from "@/components/analytics/board/add-widget";
import {
  addTileAction,
  createDashboardAction,
  deleteDashboardAction,
  patchDashboardAction,
  removeTileAction,
  reorderTilesAction,
  retileAction,
} from "./actions";

export const dynamic = "force-dynamic";

/**
 * Saved dashboards: the measures someone looks at every morning, arranged once.
 *
 * A dashboard stores measure IDS and the options each tile pins, so corrected maths reaches
 * every dashboard showing that measure and a dashboard can never drift into being a second,
 * stale copy of the widget library.
 *
 * The whole thing is answered in ONE request, because a tile per request would give each
 * figure its own `as_of` and a dozen instants do not reconcile. The period in the URL is a
 * DEFAULT: it fills in only what a tile has not pinned.
 *
 * Which dashboard is open lives in `?dash=`, so the link is shareable and Back steps
 * through them; with nothing named, your default opens, and failing that the first one.
 *
 * Arranging is a mode — see `BoardSurface`. Nothing is written until Save layout.
 */
/**
 * The periods a board offers. A subset of `EXPLORE_RANGES` — every id here must exist
 * there, which the gate asserts, so a board can never offer a range the engine refuses.
 */
const BOARD_RANGES = EXPLORE_RANGES.filter((r) =>
  ["30d", "90d", "6m", "12m", "this_year"].includes(r.id),
);

/**
 * How finely the board is cut — a different question from how far back it reaches. The old
 * control mixed the two and offered "Daily" beside "3 months"; the engine takes `grain` and
 * `range` separately.
 *
 * Only grains EVERY measure on the board can answer are offered (see below): a measure is
 * free to publish fewer, and offering one it refuses would be a control that fails a tile.
 */
const GRAIN_IDS = ["day", "week", "month", "quarter", "year"] as const;

export default async function DashboardsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    dash?: string;
    range?: string;
    grain?: string;
    /** A custom window, as calendar dates. Both or neither — one alone is not a period. */
    start?: string;
    end?: string;
  }>;
}) {
  const { biz } = await params;
  const {
    dash,
    range: rangeParam,
    grain: grainParam,
    start: startParam,
    end: endParam,
  } = await searchParams;
  await requirePermission("views:view", "ops");

  // The ANALYTICS vocabulary, not the report one. A tile resolves through the semantic
  // layer, whose named ranges are 7d/30d/90d/6m/12m/this_month/… — the retired report list
  // offered "daily" and "3m", which exist nowhere, so every tile answered 422.
  const range = (BOARD_RANGES.some((r) => r.id === rangeParam) ? rangeParam : "12m") as string;

  /*
    The custom window. Both dates or neither: the engine would take a lone `start` and
    answer to today, which is a period nobody asked for. Ordered here too, so a
    hand-edited URL cannot ask for a window that ends before it begins.
  */
  const isYmd = (v: string | undefined): v is string => v != null && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const customWindow =
    isYmd(startParam) && isYmd(endParam) && startParam <= endParam
      ? { start: startParam, end: endParam }
      : null;

  const crumbs = [{ label: "Reports", href: `/businesses/${biz}/reports` }];

  // Never throws — a missing pill costs the pill, not the page.
  const syncedAtP = getSyncedAt(biz);
  let dashboards: ReportDashboard[], businesses;
  try {
    [dashboards, businesses] = await Promise.all([
      listReportDashboards(biz).then((r) => r.data),
      listBusinesses(),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Dashboards" breadcrumbs={crumbs} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  // Your own default first: `is_default` is per OWNER, so a shared dashboard someone else
  // defaulted is not yours to land on.
  const selected =
    dashboards.find((d) => d.id === dash) ??
    dashboards.find((d) => d.is_mine && d.is_default) ??
    dashboards.find((d) => d.is_mine) ??
    dashboards[0] ??
    null;

  // Two passes only when a grain is asked for: the first tells us which grains this board's
  // measures share, the second applies the one the operator picked if they all support it.
  const probe = selected ? await buildBoardTiles(selected, biz, { range, ...customWindow }) : null;
  const boardGrains = GRAIN_IDS.filter(
    (g) =>
      (probe?.measures ?? []).length > 0 &&
      probe!.tiles.every((t) => {
        const m = probe!.measures.find((x) => x.id === t.report_key);
        return m == null || (m.grains as readonly string[]).includes(g);
      }),
  );
  const grain = boardGrains.includes((grainParam ?? "") as (typeof GRAIN_IDS)[number])
    ? grainParam
    : undefined;
  const board =
    selected && grain
      ? await buildBoardTiles(selected, biz, { range, granularity: grain, ...customWindow })
      : probe;
  // The segments the picker offers. A failure here costs the picker, never the board — every
  // tile still answers for the whole book without it.
  const segments: Segment[] = selected
    ? await listSegments(biz)
        .then((r) => r.data)
        .catch(() => [])
    : [];
  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;
  const syncedAt = await syncedAtP;
  const basePath = `/businesses/${biz}/reports/dashboards`;
  // A PRESET link clears the custom window — picking "Last 30 days" means that, not that
  // plus the dates still sitting in the URL. Every other link carries it through.
  const hrefFor = (over: { range?: string; grain?: string; keepWindow?: boolean }) =>
    `${basePath}?${new URLSearchParams({
      ...(selected ? { dash: selected.id } : {}),
      range: over.range ?? range,
      ...((over.grain ?? grain) ? { grain: (over.grain ?? grain) as string } : {}),
      ...(over.keepWindow && customWindow ? customWindow : {}),
    }).toString()}`;
  const hrefForRange = (r: string) => hrefFor({ range: r });

  // Inline server actions so each control reaches the engine with the business and
  // dashboard already bound — the client half never has to know the route it lives on.
  async function create(draft: {
    name: string;
    visibility: DashboardVisibility;
    is_default: boolean;
  }) {
    "use server";
    return createDashboardAction(biz, draft);
  }
  async function rename(id: string, name: string) {
    "use server";
    return patchDashboardAction(biz, id, { name });
  }
  async function reshare(id: string, visibility: DashboardVisibility) {
    "use server";
    return patchDashboardAction(biz, id, { visibility });
  }
  async function setDefault(id: string, isDefault: boolean) {
    "use server";
    return patchDashboardAction(biz, id, { is_default: isDefault });
  }
  async function remove(id: string) {
    "use server";
    return deleteDashboardAction(biz, id);
  }
  const openId = selected?.id ?? "";
  async function addTile(tile: {
    report_key: string;
    width_units?: number;
    range?: string;
    granularity?: string;
    group_by?: string;
    shape?: "series" | "totals";
    segment_id?: string;
  }) {
    "use server";
    return addTileAction(biz, openId, tile);
  }
  async function removeTile(tile: string) {
    "use server";
    return removeTileAction(biz, openId, tile);
  }
  async function reorder(tiles: string[]) {
    "use server";
    return reorderTilesAction(biz, openId, tiles);
  }
  async function retile(tile: string, units: TileUnits) {
    "use server";
    return retileAction(biz, openId, tile, {
      width_units: units.width,
      height_units: units.height,
    });
  }

  const tabs = (
    <BoardTabs
      dashboards={dashboards}
      selectedId={selected?.id ?? null}
      basePath={basePath}
      onCreate={create}
      onRename={rename}
      onVisibility={reshare}
      onDefault={setDefault}
      onDelete={remove}
    />
  );

  /* The period is a DEFAULT for the whole dashboard: it fills in only what a tile has not
     pinned, so "this dashboard, over three months" is one click rather than an edit of
     every tile. */
  const controls = selected ? (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <PeriodPicker
        ranges={BOARD_RANGES.map(({ id: r, label }) => ({
          id: r,
          label,
          href: hrefForRange(r),
        }))}
        range={range}
        basePath={basePath}
        carry={{ dash: selected.id, ...(grain ? { grain } : {}) }}
        custom={{ start: customWindow?.start ?? null, end: customWindow?.end ?? null }}
        resolved={board?.resolved ?? null}
      />
      {/* Only when there is a choice: with one shared grain there is nothing to pick. */}
      {boardGrains.length > 1 ? (
        <GrainControl
          grains={boardGrains.map((g) => ({
            id: g,
            label: g,
            // Grain keeps the window; pressing the pinned grain again unpins it.
            href: hrefFor({ grain: g === grain ? "" : g, keepWindow: true }),
          }))}
          grain={grain ?? ""}
        />
      ) : null}
    </div>
  ) : null;

  // The whole dashboard, as one file — built from the same answers the tiles render, so the
  // download and the screen cannot disagree.
  const download = selected ? (
    <Button asChild variant="outline" size="sm" className="bg-card">
      <a
        href={`${basePath}/csv?${new URLSearchParams({
          dash: selected.id,
          range,
          ...(customWindow ?? {}),
        })}`}
      >
        <Download className="size-3.5 text-muted-foreground" />
        Download dashboard
      </a>
    </Button>
  ) : null;

  // The open board's own tile sizes for a period change; a generic board for a switch.
  const pendingSkeleton = {
    other: <BoardSkeleton />,
    ...(selected && board
      ? {
          [selected.id]: (
            <BoardSkeleton
              tiles={board.tiles.map((t) =>
                clampUnits(
                  { width: t.width_units, height: t.height_units },
                  t.result ? roleOfResult(t.result) : "figure",
                ),
              )}
            />
          ),
        }
      : {}),
  };

  return (
    <NavPendingProvider>
      <PageHeader
        title="Dashboards"
        description="The numbers you read every morning. Arrange them one time, then open them by name."
        breadcrumbs={crumbs}
        actions={
          <div className="flex items-center gap-4">
            <SyncedBadge syncedAt={syncedAt} />
            <Link
              href={`/businesses/${biz}/reports/stats`}
              className="text-sm font-medium text-primary hover:underline"
            >
              Stats
            </Link>
            <Link
              href={`/businesses/${biz}/reports/explore`}
              className="text-sm font-medium text-primary hover:underline"
            >
              Explore metrics →
            </Link>
          </div>
        }
      />

      {selected == null || board == null ? (
        <>
          {tabs}
          <PendingContent skeleton={<BoardSkeleton />}>
            <section className="rounded-xl border bg-card">
              <EmptyState
                title="No dashboards yet"
                description="Create a dashboard, then add the numbers that you want to see together. Each person in the organization can have their own dashboards. You decide if you share yours."
              />
            </section>
          </PendingContent>
        </>
      ) : (
        <BoardSurface
          biz={biz}
          boardId={selected.id}
          name={selected.name}
          tiles={board.tiles}
          canEdit={selected.is_mine}
          tabs={tabs}
          controls={controls}
          download={download}
          footer={
            board.asOf
              ? `All tiles measured at the same instant: ${fmtDateTime(board.asOf, tz)}.`
              : null
          }
          pendingSkeleton={pendingSkeleton}
          addWidget={
            <AddWidget biz={biz} measures={board.measures} segments={segments} onAdd={addTile} />
          }
          onReorder={reorder}
          onRemove={removeTile}
          onRetile={retile}
        />
      )}
    </NavPendingProvider>
  );
}
