import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import type { EventRow } from "@/modules/events/emit";
import {
  creditNoteAllocations,
  creditNotes,
  customers,
  hubspotConnections,
  invoices,
  payments,
  prices,
  products,
  subscriptions,
} from "@db/schema";
import { parseSettings } from "./settings";

const log = createLogger("hubspot.sink");

/** A local record the engine knows how to push. */
export interface QueuedResource {
  type: "customer" | "subscription" | "price" | "invoice";
  id: string;
}

/** Finalized invoices among `ids`: drafts never sync. */
async function finalized(tx: Tx, biz: string, ids: string[]): Promise<QueuedResource[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(eq(invoices.businessId, biz), inArray(invoices.id, ids), ne(invoices.status, "pending")),
    );
  return rows.map((r) => ({ type: "invoice" as const, id: r.id }));
}

/**
 * What an event touched, as push-able records. A subscription change also moves its customer.
 * Invoices queue only when invoice sync is on: a payment or credit note moves its invoice.
 */
async function resourcesOf(
  tx: Tx,
  event: EventRow,
  withInvoices: boolean,
): Promise<QueuedResource[]> {
  const biz = event.businessId!;
  const ref = event.resourceId;
  if (!ref) return [];
  switch (event.resourceType) {
    case "customer": {
      const [r] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.businessId, biz), eq(customers.publicId, ref)))
        .limit(1);
      return r ? [{ type: "customer", id: r.id }] : [];
    }
    case "subscription": {
      const [r] = await tx
        .select({ id: subscriptions.id, customerId: subscriptions.customerId })
        .from(subscriptions)
        .where(and(eq(subscriptions.businessId, biz), eq(subscriptions.publicId, ref)))
        .limit(1);
      return r
        ? [
            { type: "subscription", id: r.id },
            { type: "customer", id: r.customerId },
          ]
        : [];
    }
    case "invoice": {
      const [r] = await tx
        .select({
          id: invoices.id,
          status: invoices.status,
          customerId: invoices.customerId,
          subscriptionId: invoices.subscriptionId,
        })
        .from(invoices)
        .where(and(eq(invoices.businessId, biz), eq(invoices.publicId, ref)))
        .limit(1);
      if (!r) return [];
      const out: QueuedResource[] = [{ type: "customer", id: r.customerId }];
      if (r.subscriptionId) out.push({ type: "subscription", id: r.subscriptionId });
      if (withInvoices && r.status !== "pending") out.push({ type: "invoice", id: r.id });
      return out;
    }
    case "payment": {
      if (!withInvoices) return [];
      const [r] = await tx
        .select({ invoiceId: payments.invoiceId })
        .from(payments)
        .where(and(eq(payments.businessId, biz), eq(payments.publicId, ref)))
        .limit(1);
      return r?.invoiceId ? finalized(tx, biz, [r.invoiceId]) : [];
    }
    case "credit_note": {
      if (!withInvoices) return [];
      const [cn] = await tx
        .select({ id: creditNotes.id, invoiceId: creditNotes.invoiceId })
        .from(creditNotes)
        .where(and(eq(creditNotes.businessId, biz), eq(creditNotes.publicId, ref)))
        .limit(1);
      if (!cn) return [];
      const allocated = await tx
        .select({ invoiceId: creditNoteAllocations.invoiceId })
        .from(creditNoteAllocations)
        .where(eq(creditNoteAllocations.creditNoteId, cn.id));
      const ids = new Set(allocated.map((a) => a.invoiceId).filter((x): x is string => !!x));
      if (cn.invoiceId) ids.add(cn.invoiceId);
      return finalized(tx, biz, [...ids]);
    }
    case "product": {
      // HubSpot products are per price, so a product change moves each of its prices.
      const rows = await tx
        .select({ id: prices.id })
        .from(prices)
        .innerJoin(products, eq(products.id, prices.productId))
        .where(and(eq(products.businessId, biz), eq(products.publicId, ref)));
      return rows.map((r) => ({ type: "price" as const, id: r.id }));
    }
    case "price": {
      const [r] = await tx
        .select({ id: prices.id })
        .from(prices)
        .where(and(eq(prices.businessId, biz), eq(prices.publicId, ref)))
        .limit(1);
      return r ? [{ type: "price", id: r.id }] : [];
    }
    default:
      return [];
  }
}

/** Queue records for push; one unclaimed row per record, so repeats coalesce. */
export async function enqueueResources(
  tx: Tx,
  conn: { id: string; organizationId: string; businessId: string },
  resources: QueuedResource[],
  reason: string,
): Promise<void> {
  for (const r of resources) {
    await tx.execute(sql`
      INSERT INTO hubspot_sync_queue
        (organization_id, business_id, connection_id, resource_type, resource_id, reason)
      VALUES (${conn.organizationId}, ${conn.businessId}, ${conn.id}, ${r.type}, ${r.id}, ${reason})
      ON CONFLICT (connection_id, resource_type, resource_id) WHERE locked_at IS NULL
      DO UPDATE SET reason = EXCLUDED.reason
    `);
  }
}

/**
 * Called by the integrations sink (`modules/integrations/sink.ts`) for every event.
 * Queue a push for whatever the event touched, in the emitting transaction (outbox): the
 * push exists iff the change committed. A savepoint contains any failure here, so a HubSpot
 * fault can never roll back the billing change that emitted the event.
 */
export async function queueHubSpotSync(tx: Tx, event: EventRow): Promise<void> {
  if (!event.businessId) return;
  try {
    await tx.transaction(async (sp) => {
      const [conn] = await sp
        .select({
          id: hubspotConnections.id,
          organizationId: hubspotConnections.organizationId,
          businessId: hubspotConnections.businessId,
          settings: hubspotConnections.settings,
        })
        .from(hubspotConnections)
        .where(
          and(
            eq(hubspotConnections.businessId, event.businessId!),
            eq(hubspotConnections.status, "active"),
          ),
        )
        .limit(1);
      if (!conn) return;
      const invoicesOn = parseSettings(conn.settings).invoices.enabled;
      const resources = await resourcesOf(sp, event, invoicesOn);
      if (resources.length > 0) await enqueueResources(sp, conn, resources, event.type);
    });
  } catch (err) {
    log.error(err, { event: "hubspot_queue_failed", type: event.type, resource: event.resourceId });
  }
}
