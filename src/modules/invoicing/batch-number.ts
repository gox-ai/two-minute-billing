import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { activatePaidCreditGrants } from "@/modules/credits/packs";
import { withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { getTraceId } from "@/platform/trace";
import { invoices } from "@db/schema";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { nextInvoiceNumbers } from "./service";

/** Invoices whose events are emitted at once, each in its own transaction. */
const EMIT_CONCURRENCY = 8;

/**
 * Number a business's waiting renewal invoices, then emit their held-back events.
 *
 *  1. Number: one transaction takes up to a batch of unnumbered invoices (oldest first) and
 *     ONE counter update. Single-flight per business; a crash leaves the batch unnumbered.
 *  2. Emit: lanes claim numbered invoices one at a time (`skip locked`, so concurrent runs share
 *     the work instead of queueing on each other's rows) and emit `invoice_generated` (and
 *     `invoice_paid` when nothing is owed) in the claiming transaction, which also clears
 *     `awaiting_number` and makes the invoice due for collection: each event is emitted once.
 *
 * Returns how many invoices it numbered; a full batch means more may be waiting.
 */
export async function numberAwaitingInvoices(
  organizationId: string,
  businessId: string,
  limit: number = config.INVOICE_NUMBER_BATCH,
): Promise<number> {
  const numbered = await withTenant(organizationId, async (tx) => {
    // A second numberer would only queue on the counter row.
    const [lock] = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext(${"number_invoices:" + businessId})) ok`,
    )) as unknown as Array<{ ok: boolean }>;
    if (!lock?.ok) return 0;
    const rows = await tx
      .select({ id: invoices.id, createdAt: invoices.createdAt })
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, businessId),
          eq(invoices.awaitingNumber, true),
          isNull(invoices.number),
        ),
      )
      .orderBy(asc(invoices.createdAt), asc(invoices.id))
      .limit(limit);
    if (rows.length === 0) return 0;
    const numbers = await nextInvoiceNumbers(
      tx,
      businessId,
      rows.map((r) => r.createdAt),
    );
    const assigned = rows.map((r, i) => ({ id: r.id, number: numbers[i]! }));
    await tx.execute(sql`
      update invoices i set number = v.number
      from jsonb_to_recordset(${JSON.stringify(assigned)}::jsonb) as v(id uuid, number text)
      where i.id = v.id`);
    return rows.length;
  });

  // Drains rows a crashed run numbered but never emitted, too.
  const lane = async () => {
    while (await emitNextNumbered(organizationId, businessId));
  };
  await Promise.all(Array.from({ length: EMIT_CONCURRENCY }, lane));
  return numbered;
}

/**
 * Claim one numbered, unemitted invoice and emit what `commitSubscriptionPeriodInvoice` emits for
 * a fresh invoice with no credit draw. False when none is left.
 */
async function emitNextNumbered(organizationId: string, businessId: string): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const [inv] = await tx
      .update(invoices)
      .set({
        awaitingNumber: false,
        collectDueAt: sql`now()`,
        collectTraceId: getTraceId() ?? null,
      })
      .where(
        eq(
          invoices.id,
          sql`(select id from invoices where business_id = ${businessId} and awaiting_number
               and number is not null order by created_at, id limit 1 for update skip locked)`,
        ),
      )
      .returning();
    if (!inv) return false;
    if (inv.totalMinor > 0n && inv.amountDueMinor === 0n) {
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "invoice_paid",
        data: buildEventData(
          "invoice_paid",
          { id: inv.publicId, amount_minor: Number(inv.totalMinor), currency: inv.currency },
          null,
          { paid_with_credit: true },
        ),
      });
      await activatePaidCreditGrants(tx, { organizationId, invoiceId: inv.id });
    }
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "invoice_generated",
      data: buildEventData("invoice_generated", {
        id: inv.publicId,
        total_minor: Number(inv.totalMinor - inv.promotionalCreditsAppliedMinor),
        currency: inv.currency,
        status: inv.status,
      }),
    });
    return true;
  });
}
