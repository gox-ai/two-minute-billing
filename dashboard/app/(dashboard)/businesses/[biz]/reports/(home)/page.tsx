import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";

/**
 * Reports opens on the dashboards.
 *
 * This section was a bespoke Revenue page — a hand-built retention strip and an
 * MRR-movement-by-plan table assembled from the analytics payload, both figures the report
 * layer already answers. It was therefore a SECOND implementation of them, on a screen
 * nobody could rearrange, add to or share. That content now lives on Business overview.
 *
 * A redirect rather than a deleted route: this path is the sidebar entry, so it has to
 * lead somewhere, and it lands on the DASHBOARDS — a saved board is the section's home
 * screen, which is why there is no separate overview page.
 *
 * Guarded like every other page in the section: a hop is still an entry point, and refusing at
 * the entry beats bouncing an unauthorized operator onwards to be refused there.
 */
export default async function ReportsPage({ params }: { params: Promise<{ biz: string }> }) {
  await requirePermission("reports:view", "ops");
  const { biz } = await params;
  redirect(`/businesses/${biz}/reports/dashboards`);
}
