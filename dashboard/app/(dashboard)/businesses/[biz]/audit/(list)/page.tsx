import { listBusinesses } from "@/lib/api";
import { listBusinessAuditLogs } from "@/lib/api/audit";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AuditTable } from "@/components/audit/audit-table";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

export default async function BusinessAuditLogPage({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("audit_logs:view", "manager");

  let businesses, logs;
  try {
    [businesses, logs] = await Promise.all([
      listBusinesses(),
      listBusinessAuditLogs(biz, { limit: 50 }),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Audit Log" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="All recorded actions for this business."
        breadcrumbs={[{ label: name, href: `/businesses/${biz}` }, { label: "Audit Log" }]}
      />

      <Card>
        <CardContent>
          {/* Chrome stays visible at zero rows — the table owns its empty state. */}
          <AuditTable
            rows={logs.data}
            total={logs.total ?? logs.data.length}
            hasMore={logs.has_more}
            nextCursor={logs.next_cursor}
            showBusiness={false}
            biz={biz}
          />
        </CardContent>
      </Card>
    </>
  );
}
