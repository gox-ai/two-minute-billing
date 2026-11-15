import { notFound } from "next/navigation";
import Link from "next/link";
import { listBusinesses, isApiNotFound, listPrices, listProducts } from "@/lib/api";
import { countMeterEventsLastDay, getMeter, listUsageEvents } from "@/lib/api/meters";
import { listCreditUnits } from "@/lib/api/credits";
import { costSentence, creditCostRefusal, type UnitNames } from "@/lib/meter-credit-cost";
import { allows, requirePermission } from "@/lib/session";
import { fmtDate } from "@/lib/format-date";
import { meterAggregationLabel } from "@/lib/meters";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IdChip, StatusChip } from "@/components/patterns/chip";
import { KeyValueGrid } from "@/components/patterns/key-value-grid";
import {
  Facts,
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
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import { ArchiveMeterButton, SendTestEventDialog } from "@/components/catalog/meter-actions";
import {
  MeterCreditCostButton,
  RemoveCreditCostButton,
} from "@/components/catalog/meter-credit-cost";
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
    if (isApiNotFound(e)) notFound();
    return (
      <>
        <PageHeader title="Meter" />
        <ErrorState
          error={e}
          thing="meter"
          back={{ label: "View meters", href: `/businesses/${biz}/catalog/meters` }}
          retry
        />
      </>
    );
  }
  if (!m) notFound();

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

  // The credit cost card: units with no money value, the plans, and a price that bills the
  // meter in money (the API refuses a cost then). Each read degrades on its own.
  const [units, prices, products] = await Promise.all([
    listCreditUnits(biz).catch(() => null),
    canManage ? listPrices(biz).catch(() => null) : Promise.resolve(null),
    canManage || m.credit_cost?.overrides.length
      ? listProducts(biz).catch(() => null)
      : Promise.resolve(null),
  ]);
  const unitNames: Record<string, UnitNames> = Object.fromEntries(
    (units?.data ?? []).map((u) => [u.id, { name: u.name, plural: u.plural_name }]),
  );
  const costUnits = (units?.data ?? [])
    .filter((u) => u.status === "active" && u.minor_per_unit === null)
    .map((u) => ({ id: u.id, name: u.name, plural_name: u.plural_name }));
  const productName = new Map((products?.data ?? []).map((p) => [p.id, p.name]));
  const planOptions = (products?.data ?? [])
    .filter((p) => (p.kind ?? "plan") === "plan")
    .map((p) => ({ value: p.id, label: p.name }));
  const billingPrice = (prices?.data ?? []).find((p) => p.meter === m.id && p.active !== false);
  const cost = m.credit_cost ?? null;
  const refusal = creditCostRefusal(m);
  const costUnitNames = cost
    ? (unitNames[cost.unit] ?? { name: cost.unit, plural: cost.unit })
    : null;
  const subscriptionCosts = (cost?.overrides ?? []).filter((o) => "subscription" in o).length;

  const filters = Object.entries(m.filters);
  const tabHref = (t: string) => (t === "recent" ? href : `${href}?tab=${t}`);

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: business?.name ?? biz, href: `/businesses/${biz}` },
          { label: "Product catalog" },
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

      <Zone title="Credits">
        <Row span="12">
          <RecordCard
            id="credit-cost"
            title="Credit cost"
            meta={cost ? "Paid with credits" : undefined}
            actions={
              canManage && !refusal && (cost || (!billingPrice && costUnits.length > 0)) ? (
                <>
                  <MeterCreditCostButton
                    biz={biz}
                    meter={m.id}
                    aggregation={m.aggregation}
                    valueProperty={m.value_property}
                    cost={cost}
                    units={costUnits}
                    plans={planOptions}
                  />
                  {cost ? <RemoveCreditCostButton biz={biz} meter={m.id} /> : null}
                </>
              ) : null
            }
          >
            {cost && costUnitNames ? (
              <div className="flex flex-col gap-3">
                <Facts
                  rows={[
                    { label: "Credit unit", value: costUnitNames.plural },
                    {
                      label: "Cost",
                      value: costSentence(
                        cost.credits_per_unit,
                        costUnitNames,
                        m.aggregation,
                        m.value_property,
                      ),
                    },
                    ...cost.overrides.flatMap((o) =>
                      "product" in o
                        ? [
                            {
                              label: productName.get(o.product) ?? o.product,
                              value: costSentence(
                                o.credits_per_unit,
                                costUnitNames,
                                m.aggregation,
                                m.value_property,
                              ),
                            },
                          ]
                        : [],
                    ),
                  ]}
                />
                {subscriptionCosts > 0 ? (
                  <p className="m-0 text-xs text-muted-foreground">
                    {subscriptionCosts === 1
                      ? "1 subscription has its own cost."
                      : `${subscriptionCosts} subscriptions have their own cost.`}{" "}
                    You can change them through the API.
                  </p>
                ) : null}
              </div>
            ) : refusal ? (
              <p className="m-0 text-sm text-muted-foreground">{refusal}</p>
            ) : billingPrice ? (
              <Alert tone="neutral">
                A price bills this meter in money, so its usage cannot also be paid with credits. To
                use credits, archive that price first.{" "}
                <Link
                  href={`/businesses/${biz}/catalog/products/${billingPrice.product}/prices/${billingPrice.id}`}
                  className="text-primary hover:underline"
                >
                  View price
                </Link>
              </Alert>
            ) : costUnits.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                No credit cost. To pay this meter with credits, create a credit unit with no money
                value first.{" "}
                {canManage ? (
                  <Link
                    href={`/businesses/${biz}/settings/credit-units/new`}
                    className="text-primary hover:underline"
                  >
                    Create a credit unit
                  </Link>
                ) : null}
              </p>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">
                No credit cost. Events of this meter take no credits.
              </p>
            )}
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Events">
        <nav aria-label="Events" className={SEGMENT_TRACK}>
          <SegmentIndicator />
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
                units={unitNames}
              />
            )}
          </RecordCard>
        </Row>
      </Zone>
      {/* A meter that credits pay is not billed through a price. */}
      {canManage && !cost ? (
        <p className="text-sm text-muted-foreground">
          To bill this meter, add a price with the Usage model to a plan or add-on and select this
          meter in “Bill from a meter”.{" "}
          <Button asChild variant="link" className="h-auto p-0">
            <Link href={`/businesses/${biz}/catalog/plans`}>View plans</Link>
          </Button>
        </p>
      ) : null}
    </div>
  );
}
