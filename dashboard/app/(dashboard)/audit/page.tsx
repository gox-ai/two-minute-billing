import { listBusinesses } from "@/lib/api";
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
  let businessNames: Record<string, string> = {};
  try {
    logs = await listAuditLogs({ limit: 50 });
    const businesses = await listBusinesses().catch(() => null);
    businessNames = Object.fromEntries((businesses?.data ?? []).map((b) => [b.id, b.name]));
  } catch (e) {
    return (
      <>
        <PageHeader
          title="Audit log"
          breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Audit log" }]}
        />
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
          title: "Audit log",
          breadcrumbs: [{ label: "Overview", href: "/" }, { label: "Audit log" }],
          description: "All actions across every business in this organization.",
          actions: <span className="text-xs text-muted-foreground">Times in {tz}</span>,
        }}
        rows={logs.data}
        total={logs.total ?? logs.data.length}
        hasMore={logs.has_more}
        nextCursor={logs.next_cursor}
        showBusiness
        businessNames={businessNames}
      />
    </>
  );
}
