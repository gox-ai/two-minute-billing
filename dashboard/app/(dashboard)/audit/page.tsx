import { listAuditLogs } from "@/lib/api/audit";
import { requirePermission } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
import { PageHeader } from "@/components/page-header";
import { AuditTable } from "@/components/audit/audit-table";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

export default async function AuditLogPage() {
  await requirePermission("audit_logs:view", "manager");
  // Only to LABEL the column below: the table itself is a client component and reads the
  // same value from context (`useDisplayTz`). /audit spans every business in the org, so
  // the organization's zone is the one that applies.
  const tz = await orgTz();

  let logs;
  try {
    logs = await listAuditLogs({ limit: 50 });
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

  return (
    <>
      {/* Chrome stays visible at zero rows — the table owns its empty state. */}
      <AuditTable
        page={{
          title: "Audit Log",
          description: "All actions across every business in this organization.",
          actions: <span className="text-xs text-muted-foreground">Times in {tz}</span>,
        }}
        rows={logs.data}
        total={logs.total ?? logs.data.length}
        hasMore={logs.has_more}
        nextCursor={logs.next_cursor}
        showBusiness
      />
    </>
  );
}
