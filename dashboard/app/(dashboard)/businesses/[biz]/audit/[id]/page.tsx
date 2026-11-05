import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { requirePermission, allows } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { CopyButton } from "@/components/patterns/copy-button";
import { Chip, IdChip } from "@/components/patterns/chip";
import {
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
} from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { ErrorState } from "@/components/states";
import { fmtDateTime } from "@/lib/format";
import { getBusinessAuditRecord } from "@/components/audit/api";
import { RecordBlock } from "@/components/audit/record-block";
import { actionHeadline, actorLabel, humaniseAction } from "@/components/audit/labels";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * P4 / 0149 — the Activity Log drill-in: who did what, from where, and — per resource
 * the action touched — which fields moved, in the context of the whole record.
 *
 * A NEW page rather than the event detail page, and rather than enriching that
 * page, because the two answer different questions and only one of them is an
 * audit. `/events/[evt]` is a DEVELOPER surface: it shows the webhook envelope, the
 * full post-change snapshot and per-endpoint delivery attempts, gated on the
 * `developer` permission. An audit row is an OPERATIONS record — actor, source, IP,
 * changed fields — gated on `manager`, and it exists for actions that emit no event
 * at all (`invoice.update`), so it cannot live inside an event page without
 * inventing an event for those. Merging them would also have meant either showing
 * webhook deliveries to a manager or the diff to a developer-only page.
 *
 * ONE PAGE, MANY BLOCKS (0149). One action can change several resources, so the page
 * renders a block each and hoists the one named by `?source=` — the record the
 * reader came from — to the top. That is what makes "Subscription activated" and
 * "Invoice raised" read as one act instead of two coincidences.
 */

/** Resource → its detail route. Only types with a real page are linked. */
const RESOURCE_HREF: Record<string, (biz: string, id: string) => string> = {
  invoice: (biz, id) => `/businesses/${biz}/invoices/${id}`,
  credit_note: (biz, id) => `/businesses/${biz}/credit_notes/${id}`,
  customer: (biz, id) => `/businesses/${biz}/customers/${id}`,
  subscription: (biz, id) => `/businesses/${biz}/subscriptions/${id}`,
};

export default async function AuditLogDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; id: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const { biz, id } = await params;
  const { source } = await searchParams;
  // Same gate as the Audit Log list this drills in from.
  const me = await requirePermission("audit_logs:view", "manager");

  let record, businesses;
  try {
    [record, businesses] = await Promise.all([
      getBusinessAuditRecord(biz, id, source),
      listBusinesses(),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Activity details" />
        <ErrorState
          title="We could not load this audit entry"
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz);
  const name = business?.name ?? biz;
  // Business timezone, not UTC — every other date on these screens is in it.
  const tz = business?.timezone ?? null;

  // The record's title comes from the LEADING block, which is the reader's own
  // resource when `?source=` named one. Falling back to the primary row's action
  // keeps a bookmarked link (no `source`) titled by what it primarily recorded.
  const lead = record.blocks[0];
  const title = lead ? humaniseAction(lead.action) : "Audit entry";
  const headline = lead ? actionHeadline(lead.action, lead.resource_type) : null;

  const actor = actorLabel(record.actor);

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Audit Log", href: `/businesses/${biz}/audit` },
          { label: title },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={headline ? `${headline.noun} ${headline.verb}` : "Activity details"}
        chips={<Chip className="font-mono">{record.source}</Chip>}
        facts={[
          // One prose line from the record's own fields; no IP clause when no request was behind it.
          <span key="who">
            <span className="font-medium text-foreground">{actor.text}</span> made{" "}
            {record.blocks.length === 1 ? "this change" : `${record.blocks.length} changes`}
            {record.actor_ip ? <> from {record.actor_ip}</> : null} on{" "}
            {fmtDateTime(record.occurred_at, tz)}
          </span>,
          <IdChip key="id" id={record.id} />,
        ]}
      />

      <Row span="8/4">
        <div className="flex min-w-0 flex-col gap-4">
          {record.blocks.map((block) => (
            <RecordBlock
              key={block.id}
              block={block}
              href={
                block.resource_type && block.resource_id
                  ? RESOURCE_HREF[block.resource_type]?.(biz, block.resource_id)
                  : undefined
              }
              isSource={!source || block.resource_type === source}
            />
          ))}
        </div>

        <RecordCard title="Overview">
          <Facts
            rows={[
              { label: "Occurred on", value: fmtDateTime(record.occurred_at, tz) },
              {
                // A key id for an integration, a name for our own dashboard credential.
                label: "User",
                value: (
                  <span className={cn("text-xs wrap-anywhere", actor.mono && "font-mono")}>
                    {actor.text}
                  </span>
                ),
              },
              {
                label: "Source",
                value: <Chip className="font-mono">{record.source}</Chip>,
              },
              {
                // Blank means no request behind this action (billing clock, importer, seed).
                label: "IP address",
                value: record.actor_ip ? (
                  <span className="font-mono text-xs tabular-nums">{record.actor_ip}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">No request: {record.source}</span>
                ),
              },
              {
                label: "Audit ID",
                value: (
                  <span className="inline-flex items-center gap-1">
                    <span className="font-mono text-xs wrap-anywhere">{record.id}</span>
                    <CopyButton value={record.id} />
                  </span>
                ),
              },
              // The join key across this act's audit rows, events and gateway calls; absent
              // on rows written before 0149.
              record.trace_id
                ? {
                    label: "Trace",
                    value: (
                      <span className="flex flex-col gap-0.5">
                        <span className="inline-flex items-start gap-1">
                          <span className="font-mono text-xs wrap-anywhere">{record.trace_id}</span>
                          <CopyButton value={record.trace_id} className="shrink-0" />
                        </span>
                        {/* Only an API or dashboard action came from a logged request. */}
                        {allows(me, "api_logs:view", "developer") &&
                        (record.source === "api" || record.source === "dashboard") ? (
                          <Link
                            href={`/developer/logs?trace_id=${encodeURIComponent(record.trace_id)}`}
                            className="text-primary hover:underline"
                          >
                            View request
                          </Link>
                        ) : null}
                      </span>
                    ),
                  }
                : null,
            ]}
          />
        </RecordCard>
      </Row>
    </div>
  );
}
