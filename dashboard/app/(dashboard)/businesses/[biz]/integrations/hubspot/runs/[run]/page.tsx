import Link from "next/link";
import { getBusiness } from "@/lib/api/business-settings";
import { getHubSpotRun } from "@/lib/api/hubspot";
import { requirePermission } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { ErrorState } from "@/components/states";
import { StatusChip } from "@/components/patterns/chip";
import {
  AttentionCard,
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
} from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const ACTION_LABEL = {
  created: "Created",
  updated: "Updated",
  skipped: "Skipped",
  failed: "Failed",
} as const;

/** Where a synced record lives on our side, when we have a page for it. */
function localHref(biz: string, type: string, id: string | null): string | null {
  if (!id) return null;
  if (type === "customer") return `/businesses/${biz}/customers/${id}`;
  if (type === "invoice") return `/businesses/${biz}/invoices/${id}`;
  return null;
}

export default async function HubSpotRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; run: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  const { biz, run } = await params;
  const { after } = await searchParams;
  await requirePermission("integrations:view", "admin");

  let business, detail;
  try {
    [business, detail] = await Promise.all([getBusiness(biz), getHubSpotRun(biz, run, after)]);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!business || !detail)
    return <ErrorState title="Not found" description={`We could not find the sync run ${run}.`} />;

  const tz = business.timezone;
  const hubspot = `/businesses/${biz}/integrations/hubspot`;
  return (
    <div className="flex flex-col gap-4 pb-10">
      <RecordCrumbs
        items={[
          { label: business.name, href: `/businesses/${biz}` },
          { label: "Integrations", href: `/businesses/${biz}/integrations` },
          { label: "HubSpot", href: hubspot },
          { label: fmtDateTime(detail.started_at, tz) },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title="Sync run"
        chips={<StatusChip status={detail.status} />}
        facts={[`Started ${fmtDateTime(detail.started_at, tz)}`]}
      />

      <AttentionCard
        items={
          detail.error
            ? [{ key: "error", tone: "attention", title: "Sync error", detail: detail.error }]
            : []
        }
      />

      <Row span="8/4">
        <RecordCard
          title="Records"
          flush
          footer={
            detail.items.has_more && detail.items.next_cursor ? (
              <Link
                href={`?after=${encodeURIComponent(detail.items.next_cursor)}`}
                className="text-primary hover:underline"
              >
                More records
              </Link>
            ) : undefined
          }
        >
          {detail.items.data.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              We did not send records. All records were already up to date.
            </p>
          ) : (
            <Table className="table-fixed">
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[24%]" />
                <col className="w-[14%]" />
                <col />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Record</TableHead>
                  <TableHead>HubSpot</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="pr-5">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.items.data.map((i, n) => {
                  const href = localHref(biz, i.local_type, i.local_id);
                  return (
                    <TableRow key={`${i.created_at}-${n}`}>
                      <TableCell className="pl-5 font-mono text-xs">
                        {href ? (
                          <Link href={href} className="text-primary hover:underline">
                            {i.local_id}
                          </Link>
                        ) : (
                          (i.local_id ?? i.local_type)
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {i.remote_type
                          ? `${i.remote_type}${i.remote_id ? ` ${i.remote_id}` : ""}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={i.action === "failed" ? "font-medium text-destructive" : ""}
                        >
                          {ACTION_LABEL[i.action]}
                        </span>
                      </TableCell>
                      <TableCell className="pr-5 text-muted-foreground">
                        {i.message ?? ""}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </RecordCard>

        <RecordCard title="Summary">
          <Facts
            rows={[
              { label: "Status", value: <StatusChip status={detail.status} /> },
              { label: "Started", value: fmtDateTime(detail.started_at, tz) },
              { label: "Created", value: detail.created },
              { label: "Updated", value: detail.updated },
              { label: "Skipped", value: detail.skipped },
              { label: "Failed", value: detail.failed },
            ]}
          />
        </RecordCard>
      </Row>
    </div>
  );
}
