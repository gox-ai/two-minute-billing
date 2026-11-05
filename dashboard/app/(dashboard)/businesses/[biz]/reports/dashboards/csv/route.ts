import { requirePermission } from "@/lib/session";
import { getReportDashboard } from "@/lib/dashboards-api";
import { buildBoardTiles } from "@/components/analytics/board/build-tiles";
import type { BoardTile } from "@/components/analytics/board/board-grid";
import { csvRow } from "@/lib/csv";

/**
 * The whole dashboard as one CSV.
 *
 * Built from the SAME answers the page renders — one analytics batch — so the download and
 * the screen cannot disagree and every section is on one `as_of`. A tile per request would
 * put each section on its own instant and the file would not reconcile with itself.
 *
 * A tile that could not be answered is a SECTION saying so, never a gap: a missing block
 * would read as a measure with no figures.
 *
 * Money is written in MINOR UNITS, as the API sends it — a file that pre-divided would be a
 * second opinion on the currency's exponent.
 */

function tileSection(tile: BoardTile): string[] {
  const lines: string[] = [csvRow([tile.name ?? tile.report_key, tile.report_key])];
  if (!tile.available) {
    lines.push(csvRow(["This measure is no longer available."]));
    return lines;
  }
  const r = tile.result;
  if (!r) {
    lines.push(csvRow([tile.error ?? "We could not calculate this tile."]));
    return lines;
  }

  lines.push(
    csvRow([
      `Period: ${r.range.start} to ${r.range.end}`,
      `Grain: ${r.grain}`,
      `Unit: ${r.unit}${r.unit === "money" ? " (minor units)" : ""}`,
      `Currency: ${r.currency ?? r.currency_basis}`,
    ]),
  );
  lines.push(csvRow(["Total", r.total ?? "", `basis: ${r.total_basis}`]));
  if (r.compare) {
    lines.push(
      csvRow([
        "Compared with",
        `${r.compare.start} to ${r.compare.end}`,
        r.compare.previous_total ?? "",
        `basis: ${r.compare.basis}`,
        r.compare.change_bps == null ? "" : `${r.compare.change_bps} bps`,
      ]),
    );
  }
  // The coverage note travels with the figures: a reader of the file cannot see the tile,
  // and a partial history is exactly what makes an early figure look flattering.
  if (r.coverage) lines.push(csvRow(["Coverage", r.coverage.note]));
  if (r.series.length > 0) {
    lines.push(csvRow(["Period", "Value"]));
    for (const p of r.series) lines.push(csvRow([p.label, p.value]));
  }
  if (r.split) {
    lines.push(csvRow([r.split.dimension, "Total"]));
    for (const s of r.split.series) lines.push(csvRow([s.label, s.total]));
    if (r.split.truncated) {
      lines.push(csvRow([`Top ${r.split.returned} only. This file does not include the rest.`]));
    }
  }
  return lines;
}

export async function GET(req: Request, { params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("views:view", "ops");
  const { biz } = await params;
  const qs = new URL(req.url).searchParams;
  const dash = qs.get("dash");
  if (!dash)
    return new Response(
      "We could not export the dashboard. The request has no dashboard id. Add ?dash=<id>.",
      { status: 400 },
    );

  const dashboard = await getReportDashboard(dash);
  if (!dashboard) return new Response("We could not find this dashboard.", { status: 404 });

  // The window travels with the export or the file answers a different period from the
  // screen that asked for it — which is the one thing this route promises it cannot do.
  const start = qs.get("start") ?? undefined;
  const end = qs.get("end") ?? undefined;
  const { tiles, asOf } = await buildBoardTiles(dashboard, biz, {
    range: qs.get("range") ?? undefined,
    ...(start && end ? { start, end } : {}),
  });

  const lines: string[] = [
    csvRow([dashboard.name]),
    csvRow(["As of", asOf ?? ""]),
    csvRow([`${tiles.length} tiles`]),
  ];
  for (const tile of tiles) lines.push("", ...tileSection(tile));

  const slug = dashboard.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return new Response(lines.join("\n") + "\n", {
    headers: {
      // Tenant financial data: never kept by a browser or shared cache.
      "cache-control": "no-store",
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${slug || "dashboard"}.csv"`,
    },
  });
}
