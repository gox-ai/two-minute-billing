import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { countMeterEventsLastDay, getMeter, listUsageEvents } from "@/lib/api/meters";
import { allows, requirePermission } from "@/lib/session";
import { fmtDate } from "@/lib/format";
import { meterAggregationLabel } from "@/lib/meters";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IdChip, StatusChip } from "@/components/patterns/chip";
import { KeyValueGrid } from "@/components/patterns/key-value-grid";
import {
  FigureTile,
  FigureTiles,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
} from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { ArchiveMeterButton, SendTestEventDialog } from "@/components/catalog/meter-actions";
import { UsageEventsTable } from "@/components/catalog/usage-events-table";
import { Activity } from "lucide-react";

export const dynamic = "force-dynamic";

const PAGE = 25;

export default async function MeterDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; meter: string }>;
  searchParams: Promise<{ tab?: string; after?: string }>;
}) {
  const me = await requirePermission("catalog:view", "manager");
  const { biz, meter } = await params;
  const { tab: tabParam, after } = await searchParams;
  const tab = tabParam === "unmatched" ? "unmatched" : "recent";

  let businesses, m;
  try {
    [businesses, m] = await Promise.all([listBusinesses(), getMeter(biz, meter)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Meter" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  if (!m)
    return (
      <>
        <PageHeader title="Meter" />
        <ErrorState title="Not found" description={`We could not find the meter ${meter}.`} />
      </>
    );

  const business = businesses.data.find((b) => b.id === biz);
  const tz = business?.timezone ?? null;
  const base = `/businesses/${biz}/catalog/meters`;
  const href = `${base}/${m.id}`;
  const canManage = allows(me, "meters:manage", "manager");
  const canSend = allows(me, "usage_events:manage", "ops");

  const [events, last24h, unmatchedTotal] = await Promise.all([
    listUsageEvents(
      biz,
      { meter: m.id, ...(tab === "unmatched" ? { status: "unmatched" as const } : {}) },
      { limit: PAGE, startingAfter: after ?? null },
    ).catch((e: Error) => e),
    countMeterEventsLastDay(biz, m.id),
    listUsageEvents(biz, { meter: m.id, status: "unmatched" }, { limit: 1 })
      .then((p) => p.total)
      .catch(() => null),
  ]);

  const filters = Object.entries(m.filters);
  const tabHref = (t: string) => (t === "recent" ? href : `${href}?tab=${t}`);

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: business?.name ?? biz, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Meters", href: base },
          { label: m.name },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={m.name}
        chips={<StatusChip status={m.status} />}
        facts={[
          <IdChip key="id" id={m.id} />,
          <span key="event" className="font-mono">
            {m.event_name}
          </span>,
          meterAggregationLabel(m.aggregation),
          `Created ${fmtDate(m.created_at, tz)}`,
        ]}
        actions={
          <>
            {canSend ? <SendTestEventDialog biz={biz} meter={m} /> : null}
            {canManage ? (
              <MoreMenu>
                <MoreSection heading="Meter">
                  <Link href={`${href}/edit`}>Edit meter</Link>
                  {m.status === "active" ? <ArchiveMeterButton biz={biz} meter={m} /> : null}
                </MoreSection>
              </MoreMenu>
            ) : null}
          </>
        }
      />

      <FigureTiles cols={2}>
        <FigureTile
          label="Events in last 24 hours"
          value={last24h == null ? "—" : last24h.toLocaleString("en-US")}
          note={
            m.not_billed_event_count
              ? `Not billed: ${m.not_billed_event_count.toLocaleString("en-US")} events. No subscription bills this meter for their customer.`
              : undefined
          }
        />
        <FigureTile
          label="Unmatched events"
          value={unmatchedTotal == null ? "—" : unmatchedTotal.toLocaleString("en-US")}
          note="No customer has their usage key"
          href={`${href}?tab=unmatched`}
        />
      </FigureTiles>

      <Zone title="Definition">
        <Row span="12">
          <RecordCard
            title="What it counts"
            meta={m.locked ? "Has usage · only the name can change" : undefined}
          >
            <KeyValueGrid
              columns={2}
              rows={[
                { label: "Event name", value: <span className="font-mono">{m.event_name}</span> },
                { label: "Aggregation", value: meterAggregationLabel(m.aggregation) },
                m.value_property
                  ? {
                      label: "Value property",
                      value: <span className="font-mono">{m.value_property}</span>,
                    }
                  : null,
                m.unique_property
                  ? {
                      label: "Unique property",
                      value: <span className="font-mono">{m.unique_property}</span>,
                    }
                  : null,
                m.time_unit
                  ? { label: "Time unit", value: m.time_unit === "day" ? "Day" : "Hour" }
                  : null,
                {
                  label: "Level",
                  value: m.recurring ? "Carries to the next period" : "Starts again each period",
                },
                {
                  label: "Filters",
                  value: filters.length
                    ? filters.map(([p, v]) => `${p} is ${v.join(", ")}`).join("; ")
                    : "All events",
                },
                {
                  label: "Group by",
                  value: m.group_by.length ? (
                    <span className="font-mono">{m.group_by.join(", ")}</span>
                  ) : (
                    "None"
                  ),
                },
              ]}
            />
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Events">
        <nav aria-label="Events" className={SEGMENT_TRACK}>
          <Link href={tabHref("recent")} className={segmentItem(tab === "recent")}>
            Recent events
          </Link>
          <Link href={tabHref("unmatched")} className={segmentItem(tab === "unmatched")}>
            Unmatched events
          </Link>
        </nav>
        <Row span="12">
          <RecordCard
            id="events"
            title={tab === "unmatched" ? "Unmatched events" : "Recent events"}
            meta={
              tab === "unmatched"
                ? "Add the usage key to a customer to bill these events."
                : undefined
            }
            flush={!(events instanceof Error) && events.data.length > 0}
            footer={
              !(events instanceof Error) && (after || events.has_more) ? (
                <span className="flex gap-3">
                  {after ? (
                    <Link href={tabHref(tab)} className="text-primary hover:underline">
                      First page
                    </Link>
                  ) : null}
                  {events.has_more && events.next_cursor ? (
                    <Link
                      href={`${href}?${new URLSearchParams({
                        ...(tab === "unmatched" ? { tab } : {}),
                        after: events.next_cursor,
                      })}`}
                      className="text-primary hover:underline"
                    >
                      Next page
                    </Link>
                  ) : null}
                </span>
              ) : undefined
            }
          >
            {events instanceof Error ? (
              <Alert tone="error">We could not load the events. Reload the page.</Alert>
            ) : events.data.length === 0 ? (
              <EmptyState
                icon={<Activity />}
                title={tab === "unmatched" ? "No unmatched events" : "No events yet"}
                description={
                  tab === "unmatched"
                    ? "Every event for this meter has a customer."
                    : "No events yet. Send an event to see it here."
                }
                action={
                  tab === "recent" && canSend && m.status === "active" ? (
                    <SendTestEventDialog biz={biz} meter={m} />
                  ) : undefined
                }
              />
            ) : (
              <UsageEventsTable
                biz={biz}
                events={events.data}
                tz={tz}
                valueProperty={m.value_property}
              />
            )}
          </RecordCard>
        </Row>
      </Zone>
      {canManage ? (
        <p className="text-sm text-muted-foreground">
          To bill this meter, add a price with the Usage model to a plan or addon and select this
          meter in “Bill from a meter”.{" "}
          <Button asChild variant="link" className="h-auto p-0">
            <Link href={`/businesses/${biz}/catalog/plans`}>View plans</Link>
          </Button>
        </p>
      ) : null}
    </div>
  );
}
