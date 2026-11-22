import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { invoices, payments } from "@db/schema";
import { isOurRequestFault, requestFaultTexts } from "@/providers/decline-codes";

/**
 * An invoice parked because a gateway refused OUR request (user decisions 2026-11-17): no
 * final action ends it and the payer gets no dunning mail about it. Ops correct the cause and
 * collect; once collection runs again the normal rules apply. Decided on the newest failed
 * payment, the one that parked it.
 */
export function parkedOnOurRequest(
  inv: { status: string; dunningStatus: string | null },
  newestFailure: { code: string | null; message: string | null } | null,
): boolean {
  return (
    inv.status === "payment_due" &&
    inv.dunningStatus === "parked" &&
    !!newestFailure &&
    isOurRequestFault(newestFailure)
  );
}

/** For a scan over `invoices`: the newest failed payment is NOT our refused request. */
export function notParkedOnOurRequestSql(): SQL {
  const texts = sql.join(
    [...requestFaultTexts()].map((t) => sql`${t}`),
    sql`, `,
  );
  return sql`not coalesce((
    select coalesce(p.reversal_code, p.failure_code) = 'gateway_request_rejected'
        or (coalesce(p.reversal_code, p.failure_code) = 'gateway_error'
            and p.failure_message in (${texts}))
      from payments p
     where p.invoice_id = ${invoices.id} and p.status = 'failed'
     order by p.created_at desc
     limit 1), false)`;
}

/** The same question for one invoice, by its public id. */
export async function invoiceParkedOnOurRequest(
  tx: Tx,
  input: { businessId: string; invoicePublicId: string },
): Promise<boolean> {
  const [inv] = await tx
    .select({ id: invoices.id, status: invoices.status, dunningStatus: invoices.dunningStatus })
    .from(invoices)
    .where(
      and(eq(invoices.businessId, input.businessId), eq(invoices.publicId, input.invoicePublicId)),
    )
    .limit(1);
  if (!inv || inv.dunningStatus !== "parked") return false;
  const [pay] = await tx
    .select({
      code: sql<string | null>`coalesce(${payments.reversalCode}, ${payments.failureCode})`,
      message: payments.failureMessage,
    })
    .from(payments)
    .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "failed")))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return parkedOnOurRequest(inv, pay ?? null);
}
