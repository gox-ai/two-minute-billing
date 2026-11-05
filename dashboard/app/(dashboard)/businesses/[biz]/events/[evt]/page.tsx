import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import { getEventForBusiness } from "@/lib/api/developer";
import type { EventDetail } from "@/lib/api/developer";
import { requirePermission } from "@/lib/session";
import { ErrorState, EmptyState } from "@/components/states";
import { CopyButton } from "@/components/patterns/copy-button";
import { Chip, IdChip } from "@/components/patterns/chip";
import {
  AttentionCard,
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
  type AttentionItem,
} from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { Clock } from "lucide-react";
import { ResendSection } from "@/components/webhooks/resend-section";
import { DeliveryStatusChip } from "@/components/webhooks/delivery-status-chip";
import { RedeliverButton } from "@/app/(dashboard)/developer/webhooks/[id]/redeliver-button";
import { redeliverAction } from "@/app/(dashboard)/developer/actions";
import { fmtDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Machine event_type → human label, e.g. `subscription_changed` → "Subscription changed". */
const eventName = (type: string) => type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Resource → its detail route. Only types with a real page are linked. */
const RESOURCE_HREF: Record<string, (biz: string, id: string) => string> = {
  invoice: (biz, id) => `/businesses/${biz}/invoices/${id}`,
  credit_note: (biz, id) => `/businesses/${biz}/credit_notes/${id}`,
  customer: (biz, id) => `/businesses/${biz}/customers/${id}`,
  subscription: (biz, id) => `/businesses/${biz}/subscriptions/${id}`,
};

type Delivery = NonNullable<EventDetail["webhook_deliveries"]>[number];

/**
 * One group per ENDPOINT, newest attempt first.
 *
 * A resend writes a NEW `webhook_deliveries` row (deliberately: the per-resend audit trail is
 * worth keeping, and an automatic retry already increments `attempts` on the existing row, so
 * overwriting here would erase the fact that a human intervened). Rendered one-card-per-row that
 * produced two cards headed by the same endpoint, whose endpoint-level fields — Webhook ID, API
 * Version, URL — are identical by definition. So the ROWS stay and the SCREEN groups: the latest
 * attempt gets the card, the rest collapse into a list of outcomes underneath.
 *
 * Ordered on `created_at`, not `last_attempt_at`, because the latter is null on a row nothing has
 * tried yet and that row is usually the newest.
 */
function groupByEndpoint(
  deliveries: Delivery[],
): Array<{ endpoint: string; latest: Delivery; earlier: Delivery[] }> {
  const byEndpoint = new Map<string, Delivery[]>();
  for (const d of deliveries) {
    const list = byEndpoint.get(d.endpoint);
    if (list) list.push(d);
    else byEndpoint.set(d.endpoint, [d]);
  }
  return [...byEndpoint.entries()].map(([endpoint, rows]) => {
    const sorted = [...rows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return { endpoint, latest: sorted[0]!, earlier: sorted.slice(1) };
  });
}

export default async function BusinessEventDetailPage({
  params,
}: {
  params: Promise<{ biz: string; evt: string }>;
}) {
  const { biz, evt } = await params;
  await requirePermission("events:view", "developer");

  let event, businesses;
  try {
    [event, businesses] = await Promise.all([getEventForBusiness(biz, evt), listBusinesses()]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not load the event"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  // Dates render in the business timezone, not UTC — the engine's term
  // boundaries are midnight in this zone (see components/business-tz).
  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;

  const contentEntries =
    event.content && typeof event.content === "object"
      ? Object.entries(event.content as Record<string, unknown>)
      : [];

  const title = eventName(event.event_type);
  const groups = groupByEndpoint(event.webhook_deliveries ?? []);
  const failed = groups.filter((g) => g.latest.enabled && g.latest.status === "failed");

  const resourceHref =
    event.resource?.type && event.resource.id
      ? RESOURCE_HREF[event.resource.type]?.(biz, event.resource.id)
      : undefined;
  const resource = event.resource ? (
    <span>
      <span className="font-medium">{event.resource.type}</span>
      {event.resource.id ? (
        resourceHref ? (
          <Link href={resourceHref} className="ml-1 font-mono text-xs text-primary hover:underline">
            {event.resource.id}
          </Link>
        ) : (
          <span className="ml-1 font-mono text-xs text-muted-foreground">{event.resource.id}</span>
        )
      ) : null}
    </span>
  ) : null;

  const attention = failed.map(({ endpoint, latest: d }): AttentionItem => {
    const plural = d.attempts === 1 ? "attempt" : "attempts";
    return {
      key: endpoint,
      tone: "attention",
      title:
        failed.length === 1
          ? `1 of ${groups.length} ${groups.length === 1 ? "endpoint" : "endpoints"} did not receive this event`
          : `${d.endpoint_name || d.url} did not receive this event`,
      detail: (
        <>
          {failed.length === 1 ? `${d.endpoint_name || d.url} ` : "It "}
          {d.last_response_status != null
            ? `answered HTTP ${d.last_response_status}`
            : "received no response"}{" "}
          on {d.attempts} {plural}.
          {d.last_attempt_at ? ` Last attempt ${fmtDateTime(d.last_attempt_at, tz)}.` : null}
        </>
      ),
      actions: (
        <RedeliverButton
          endpointId={d.endpoint}
          deliveryId={d.delivery_id}
          redeliverAction={redeliverAction}
          label="Resend"
        />
      ),
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: name, href: `/businesses/${biz}` },
          { label: "Events", href: `/businesses/${biz}/events` },
          { label: title },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={title}
        chips={event.webhook_status ? <DeliveryStatusChip status={event.webhook_status} /> : null}
        facts={[
          <IdChip key="id" id={event.id} />,
          <span key="type" className="font-mono text-xs">
            {event.event_type}
          </span>,
          fmtDateTime(event.occurred_at, tz),
          resource,
        ]}
      />

      <AttentionCard items={attention} columns={false} />

      <Row span="8/4">
        {/* Full-snapshot payload, one collapsible section per top-level resource key. */}
        <RecordCard title="Content" flush>
          {contentEntries.length === 0 ? (
            <div className="px-5 py-4">
              <EmptyState title="No content" description="This event has no payload." />
            </div>
          ) : (
            <div className="divide-y">
              {contentEntries.map(([key, value]) => {
                const json = JSON.stringify(value, null, 2);
                return (
                  <details key={key} className="px-5 py-3" open={contentEntries.length === 1}>
                    <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {key}
                      </code>
                      <CopyButton value={json} className="shrink-0" />
                    </summary>
                    <pre className="mt-2 max-h-[520px] overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed">
                      {json}
                    </pre>
                  </details>
                );
              })}
            </div>
          )}
        </RecordCard>

        <RecordCard title="Details">
          <Facts
            rows={[
              { label: "Name", value: title },
              {
                label: "ID",
                value: (
                  <span className="inline-flex items-center gap-1">
                    <span className="font-mono text-xs wrap-anywhere">{event.id}</span>
                    <CopyButton value={event.id} />
                  </span>
                ),
              },
              {
                label: "Event type",
                value: <Chip className="font-mono">{event.event_type}</Chip>,
              },
              { label: "Source", value: event.source ?? "—" },
              {
                label: "User",
                value: event.user ? <span className="font-mono text-xs">{event.user}</span> : "—",
              },
              { label: "API version", value: event.api_version ?? "—" },
              resource ? { label: "Resource", value: resource } : null,
              { label: "Occurred at", value: fmtDateTime(event.occurred_at, tz) },
              event.webhook_status
                ? {
                    label: "Webhook status",
                    value: <DeliveryStatusChip status={event.webhook_status} />,
                  }
                : null,
            ]}
          />
        </RecordCard>
      </Row>

      {/* One card per ENDPOINT, not one per row. */}
      <Zone title="Webhook deliveries">
        {groups.length === 0 ? (
          <div className="rounded-xl border bg-card px-5 py-4 text-sm text-muted-foreground">
            No webhook deliveries for this event. The system creates a delivery when an event fires
            while an{" "}
            <a href={`/developer`} className="font-semibold text-primary hover:underline">
              enabled webhook endpoint
            </a>{" "}
            exists. Endpoints created later do not receive past events.
          </div>
        ) : (
          <Row span="6/6">
            {groups.map((group) => {
              const d = group.latest;
              const skipped = !d.enabled || d.status === "skipped";
              return (
                <ResendSection
                  key={group.endpoint}
                  endpointId={d.endpoint}
                  deliveryId={d.delivery_id}
                  redeliverAction={redeliverAction}
                  heading={d.endpoint_name || d.endpoint}
                  queued={[d, ...group.earlier].some((x) => x.status === "pending")}
                  status={<DeliveryStatusChip status={d.enabled ? d.status : "disabled"} />}
                  subheading={
                    group.earlier.length > 0
                      ? `${group.earlier.length + 1} attempts · latest ${d.last_attempt_at ? fmtDateTime(d.last_attempt_at, tz) : "not yet sent"}`
                      : undefined
                  }
                  footer={
                    // Earlier attempts on this endpoint: only the outcome and time differ.
                    group.earlier.length > 0 ? (
                      <details>
                        <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
                          {group.earlier.length} earlier{" "}
                          {group.earlier.length === 1 ? "attempt" : "attempts"} on this endpoint
                        </summary>
                        <ul className="mt-2 space-y-1 pb-1">
                          {group.earlier.map((e) => (
                            <li
                              key={e.delivery_id}
                              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                            >
                              <DeliveryStatusChip status={e.enabled ? e.status : "disabled"} />
                              <span>
                                {e.attempts} {e.attempts === 1 ? "attempt" : "attempts"}
                              </span>
                              <span>
                                {e.last_response_status != null
                                  ? `HTTP ${e.last_response_status}`
                                  : "no response"}
                              </span>
                              <span>
                                {e.last_attempt_at ? fmtDateTime(e.last_attempt_at, tz) : "—"}
                              </span>
                              {e.last_error ? (
                                <span className="basis-full font-mono break-all">
                                  {e.last_error}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : undefined
                  }
                >
                  <Facts
                    rows={[
                      {
                        label: "Webhook ID",
                        value: (
                          <span className="inline-flex items-center gap-1">
                            <span className="font-mono text-xs wrap-anywhere">{d.endpoint}</span>
                            <CopyButton value={d.endpoint} />
                          </span>
                        ),
                      },
                      { label: "API Version", value: (event.api_version ?? "v1").toUpperCase() },
                      {
                        label: "URL",
                        value: (
                          <span className="inline-flex items-start gap-1">
                            <span className="font-mono text-xs break-all">{d.url}</span>
                            <CopyButton value={d.url} className="shrink-0" />
                          </span>
                        ),
                      },
                      {
                        label: "Status",
                        value: <DeliveryStatusChip status={d.enabled ? d.status : "disabled"} />,
                      },
                      { label: "Attempts", value: String(d.attempts) },
                      {
                        label: "Last response",
                        value:
                          d.last_response_status != null ? String(d.last_response_status) : "—",
                      },
                      d.last_error
                        ? {
                            label: "Receiver said",
                            value: (
                              <span className="inline-flex items-start gap-1">
                                <span className="font-mono text-xs break-all whitespace-pre-wrap">
                                  {d.last_error}
                                </span>
                                <CopyButton value={d.last_error} className="shrink-0" />
                              </span>
                            ),
                          }
                        : null,
                      {
                        label: "Last attempt",
                        value: d.last_attempt_at ? fmtDateTime(d.last_attempt_at, tz) : "—",
                      },
                    ]}
                  />
                  {skipped ? (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="size-3.5" />
                      Webhook skipped, as the request specified.
                    </p>
                  ) : null}
                </ResendSection>
              );
            })}
          </Row>
        )}
      </Zone>
    </div>
  );
}
