import { listBusinesses } from "@/lib/api";
import { countMeterEventsLastDay, listMeters } from "@/lib/api/meters";
import { allows, requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { MetersTable, type MeterRow } from "@/components/catalog/meters-table";

export const dynamic = "force-dynamic";

export default async function MetersPage({ params }: { params: Promise<{ biz: string }> }) {
  const me = await requirePermission("catalog:view", "manager");
  const { biz } = await params;

  let businesses, meters;
  try {
    [businesses, meters] = await Promise.all([listBusinesses(), listMeters(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Meters" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  // A bounded catalog list: one count read per meter. A failed count shows a dash.
  const rows: MeterRow[] = await Promise.all(
    meters.data.map(async (m) => ({
      ...m,
      events_24h: await countMeterEventsLastDay(biz, m.id),
    })),
  );

  return (
    <MetersTable
      page={{
        title: "Meters",
        description: "What to count from the usage events that your app sends.",
        breadcrumbs: [
          { label: name, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Meters" },
        ],
      }}
      biz={biz}
      rows={rows}
      canManage={allows(me, "meters:manage", "manager")}
    />
  );
}
