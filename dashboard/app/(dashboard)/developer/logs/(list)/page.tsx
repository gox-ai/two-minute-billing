import { listApiKeys, listBusinesses } from "@/lib/api";
import { listRequestLogs } from "@/lib/api/request-logs";
import { requirePermission } from "@/lib/session";
import { orgTz } from "@/lib/org-tz-server";
import { urlFilters } from "@/lib/list-source";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { RequestLogsTable } from "@/components/developer/request-logs-table";

export const dynamic = "force-dynamic";

/** Rows per page — keep in step with the page size in /api/lists/[entity]. */
const PAGE_SIZE = 50;

export default async function RequestLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("api_logs:view", "developer");
  const [search, tz] = await Promise.all([searchParams, orgTz()]);

  let logs, keys, businesses;
  try {
    [logs, keys, businesses] = await Promise.all([
      listRequestLogs({ limit: PAGE_SIZE }),
      // Revoked keys stay in this list, so their old requests stay reachable.
      listApiKeys(),
      listBusinesses(),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Request logs" />
        <ErrorState
          title="We could not load the request log"
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  return (
    <RequestLogsTable
      page={{
        title: "Request logs",
        breadcrumbs: [{ label: "Developers", href: "/developer" }, { label: "Request logs" }],
        description:
          "Requests that your API keys made, and changes made in this dashboard. Requests with an incorrect key or an unknown path are not in the log. We keep reads for 30 days and writes for 90 days.",
        actions: <span className="text-xs text-muted-foreground">Times in {tz}</span>,
      }}
      rows={logs.data}
      total={logs.total ?? logs.data.length}
      hasMore={logs.has_more}
      nextCursor={logs.next_cursor}
      apiKeys={keys.data.map((k) => ({
        id: k.id,
        label: `${k.name ?? `${k.prefix}…`} · ${k.livemode}${k.revoked_at ? " · revoked" : ""}`,
      }))}
      businesses={businesses.data.map((b) => ({ id: b.id, name: b.name }))}
      // Deep links: an API key row, a customer page, an audit record, a toast.
      initialFilters={urlFilters(search, {
        api_key: true,
        customer: true,
        trace_id: true,
        idempotency_key: true,
        business: true,
        created_at: true,
      })}
    />
  );
}
