import { listWebhookEndpointsDetail, listDeliveries } from "@/lib/api/developer";
import { requirePermission } from "@/lib/session";
import { IdChip } from "@/components/patterns/chip";
import { RecordCard, RecordCrumbs, RecordHeader, Zone } from "@/components/patterns/record-page";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { ErrorState } from "@/components/states";
import {
  updateWebhookEndpointAction,
  testSendAction,
  redeliverLatestAction,
  redeliverFailedAction,
} from "../../actions";
import { WebhookDetailClient } from "./webhook-detail-client";
import { DeliveriesTable } from "./deliveries-table";

export const dynamic = "force-dynamic";

/** Rows per page — the list source's default page size. */
const PAGE_SIZE = 50;

// Full webhook endpoint detail: description, event-type subscriptions, test send, delivery log.
export default async function WebhookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("webhooks:view", "developer");
  let endpoints, deliveries;
  try {
    [endpoints, deliveries] = await Promise.all([
      listWebhookEndpointsDetail(),
      listDeliveries(id, { limit: PAGE_SIZE }),
    ]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not load the endpoint"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }

  const endpoint = endpoints.data.find((e) => e.id === id);
  if (!endpoint) {
    return (
      <ErrorState
        title="Endpoint not found"
        description={`No webhook endpoint has the ID ${id}.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[{ label: "Developer", href: "/developer" }, { label: "Webhook endpoint" }]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title="Webhook endpoint"
        facts={[
          <span key="url" className="font-mono text-sm">
            {endpoint.url}
          </span>,
          <IdChip key="id" id={endpoint.id} />,
        ]}
      />

      {/* Client component: description edit, event-type subscriptions, test send */}
      <WebhookDetailClient
        endpoint={endpoint}
        updateAction={updateWebhookEndpointAction}
        testAction={testSendAction}
        resendAction={redeliverLatestAction}
        requeueAction={redeliverFailedAction}
      />

      <Zone>
        <RecordCard id="deliveries" title="Delivery log" flush>
          <DeliveriesTable
            endpointId={id}
            rows={deliveries.data}
            total={deliveries.total ?? deliveries.data.length}
            hasMore={deliveries.has_more}
            nextCursor={deliveries.next_cursor}
          />
        </RecordCard>
      </Zone>
    </div>
  );
}
