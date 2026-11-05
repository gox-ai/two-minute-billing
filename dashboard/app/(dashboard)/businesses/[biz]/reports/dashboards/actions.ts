"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import {
  addDashboardTile,
  createReportDashboard,
  deleteReportDashboard,
  patchDashboardTile,
  patchReportDashboard,
  removeDashboardTile,
  reorderDashboardTiles,
  type DashboardVisibility,
  type TileOptions,
} from "@/lib/dashboards-api";

// Every action re-checks the permission before mutating: an action is a
// network-invokable endpoint whose id ships in the client bundle, so gating the page
// that renders the control protects nothing.

export interface DashboardActionResult {
  ok: boolean;
  /** The engine's own sentence — "You already have a dashboard called 'Cash'" is fixable. */
  error?: string;
  id?: string;
}

const path = (biz: string) => `/businesses/${biz}/reports/dashboards`;

/** The engine's message, forwarded whole. A generic failure tells nobody what to change. */
function result(
  biz: string,
  res: { ok: boolean; error?: string; data?: unknown },
): DashboardActionResult {
  if (!res.ok) return { ok: false, error: res.error ?? "We could not save that change" };
  revalidatePath(path(biz));
  return { ok: true, id: (res.data as { id?: string } | undefined)?.id };
}

export async function createDashboardAction(
  biz: string,
  draft: { name: string; visibility: DashboardVisibility; is_default: boolean },
): Promise<DashboardActionResult> {
  await requirePermission("views:manage", "ops");
  return result(
    biz,
    await createReportDashboard({
      business: biz,
      name: draft.name,
      visibility: draft.visibility,
      is_default: draft.is_default,
    }),
  );
}

export async function patchDashboardAction(
  biz: string,
  id: string,
  body: { name?: string; visibility?: DashboardVisibility; is_default?: boolean },
): Promise<DashboardActionResult> {
  await requirePermission("views:manage", "ops");
  return result(biz, await patchReportDashboard(id, body));
}

export async function deleteDashboardAction(
  biz: string,
  id: string,
): Promise<DashboardActionResult> {
  await requirePermission("views:manage", "ops");
  return result(biz, await deleteReportDashboard(id));
}

export async function addTileAction(
  biz: string,
  id: string,
  tile: { report_key: string } & TileOptions,
): Promise<DashboardActionResult> {
  await requirePermission("views:manage", "ops");
  return result(biz, await addDashboardTile(id, tile));
}

export async function removeTileAction(
  biz: string,
  id: string,
  tile: string,
): Promise<DashboardActionResult> {
  await requirePermission("views:manage", "ops");
  return result(biz, await removeDashboardTile(id, tile));
}

/**
 * Change what a tile pins — today only its `size`, from the resize handle on the widget.
 *
 * A PATCH of the one tile, not a rewrite of the board: two people resizing different
 * widgets on a shared dashboard must not overwrite each other, which sending the whole
 * arrangement would do.
 */
export async function retileAction(
  biz: string,
  id: string,
  tile: string,
  body: TileOptions,
): Promise<DashboardActionResult> {
  await requirePermission("views:manage", "ops");
  return result(biz, await patchDashboardTile(id, tile, body));
}

/** The WHOLE list, each tile exactly once — see `reorderDashboardTiles`. */
export async function reorderTilesAction(
  biz: string,
  id: string,
  tiles: string[],
): Promise<DashboardActionResult> {
  await requirePermission("views:manage", "ops");
  return result(biz, await reorderDashboardTiles(id, tiles));
}
