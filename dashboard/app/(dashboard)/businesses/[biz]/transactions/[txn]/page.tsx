import { notFound } from "next/navigation";
import { getSubscription, listBusinesses } from "@/lib/api";
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
  const [cbs, dsp, catalog, sub] = await Promise.all([
    // `filters`, NOT `scope`: scope sets a RAW query key and the engine rejects anything not
    // in its allow-list of bare params, while filters render as `field[op]=value`, which is the
    // documented filter syntax.
    listGatewayWebhooks(biz, {
      limit: 50,
      filters: [{ field: "transaction", op: "is", value: t.id }],
    }).catch(() => null),
    // The disputes on this payment; soft-fail like the callback log.
    t.type === "payment" && t.reference_payment
      ? listDisputes(biz, { payment: t.reference_payment, limit: 50 }).catch(() => null)
      : null,
    t.gateway_key ? getGatewayCatalogOrEmpty() : null,
    // The plan name for the Subscription row; the id stays the fallback.
    t.subscription ? getSubscription(biz, t.subscription).catch(() => null) : null,
  ]);
  const callbacks = cbs?.data ?? [];
  const disputes: Dispute[] = dsp?.data ?? [];
  const subscriptionName = sub?.items?.find((i) => i.product_kind === "plan")?.product_name ?? null;

  const gatewayName =
    t.gateway_key && catalog ? gatewayDisplayName(t.gateway_key, catalog) : "the gateway";

  return (
    <TransactionDetailView
      biz={biz}
      gatewayName={gatewayName}
      name={name}
      tz={tz}
      livemode={livemode}
      gatewayCatalog={catalog ?? []}
      initialTransaction={t}
      initialCallbacks={callbacks}
      initialDisputes={disputes}
      subscriptionName={subscriptionName}
      canManageDisputes={allows(user, "payments:refund", "manager")}
    />
  );
}
