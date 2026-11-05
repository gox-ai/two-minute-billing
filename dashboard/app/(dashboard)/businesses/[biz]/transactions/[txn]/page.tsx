import { notFound } from "next/navigation";
import { listBusinesses } from "@/lib/api";
import { getTransaction, listGatewayWebhooks } from "@/lib/api/payments";
import { getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { gatewayDisplayName } from "@/components/gateways/gateway-meta";
import { allows, requirePermission } from "@/lib/session";
import { listDisputes, type Dispute } from "@/lib/api/disputes";
import { TransactionDetailView } from "./transaction-detail-view";

export const dynamic = "force-dynamic";

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ biz: string; txn: string }>;
}) {
  const { biz, txn } = await params;
  const user = await requirePermission("payments:view", "ops");

  const businesses = await listBusinesses();
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  // Dates render in the business timezone, not UTC — the engine's term
  // boundaries are midnight in this zone (see components/business-tz).
  const tz = businesses.data.find((b) => b.id === biz)?.timezone ?? null;
  // Stripe's dashboard selects the mode in the URL path, so the gateway deep link
  // needs this business's mode — a test charge opened without it 404s in live.
  const livemode = businesses.data.find((b) => b.id === biz)?.livemode ?? null;

  let t;
  try {
    t = await getTransaction(biz, txn);
  } catch {
    notFound();
  }

  /**
   * THE STORY OF THIS TRANSACTION, from both sides of the wire.
   *
   * Its own lifecycle (created, then settled or failed) is always available and works with no
   * gateway connectivity at all — which matters, because inbound webhooks need a publicly
   * reachable endpoint and in development there usually is not one. The webhooks add what the
   * GATEWAY said and when, including anything that happened AFTER settlement: a later refund,
   * a dispute. Neither half is sufficient alone, so they are merged chronologically
   * (`buildTimeline` in `./transaction-detail-view.tsx`, so a Refresh can rebuild it too).
   *
   * Failing softly: the log is a diagnostic, and a transaction page that 500s because the
   * webhook query hiccuped would lose the money facts too.
   */
  let callbacks: Awaited<ReturnType<typeof listGatewayWebhooks>>["data"] = [];
  try {
    // `filters`, NOT `scope`: scope sets a RAW query key and the engine rejects anything not
    // in its allow-list of bare params, while filters render as `field[op]=value`, which is the
    // documented filter syntax.
    callbacks = (
      await listGatewayWebhooks(biz, {
        limit: 50,
        filters: [{ field: "transaction", op: "is", value: t.id }],
      })
    ).data;
  } catch {
    callbacks = [];
  }

  // The disputes on this payment. Soft-fail like the callback log above.
  let disputes: Dispute[] = [];
  if (t.type === "payment" && t.reference_payment) {
    try {
      disputes = (await listDisputes(biz, { payment: t.reference_payment, limit: 50 })).data;
    } catch {
      disputes = [];
    }
  }

  const gatewayName = t.gateway_key
    ? gatewayDisplayName(t.gateway_key, await getGatewayCatalogOrEmpty())
    : "the gateway";

  return (
    <TransactionDetailView
      biz={biz}
      gatewayName={gatewayName}
      name={name}
      tz={tz}
      livemode={livemode}
      initialTransaction={t}
      initialCallbacks={callbacks}
      initialDisputes={disputes}
      canManageDisputes={allows(user, "payments:refund", "manager")}
    />
  );
}
