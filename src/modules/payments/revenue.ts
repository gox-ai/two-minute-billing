import { sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";

/** Cash actually collected in one currency: succeeded payments minus succeeded refunds. */
export interface CollectedRevenue {
  currency: string;
  amount_minor: number;
  paid_invoices_count: number;
  /** Earliest succeeded payment; imported payments keep their source date. */
  first_paid_at: Date | null;
}

/**
 * Lifetime collected revenue for a customer (every payment they made) or a subscription
 * (payments against its invoices). Same net-cash rule as `overCollectedNetCash` in
 * ops/invariants. Credits applied to invoices are not cash and are excluded; so are
 * dispute clawbacks, which the label "net of refunds" does not claim to cover.
 */
export async function collectedRevenue(
  organizationId: string,
  scope: { customerId: string } | { subscriptionId: string },
): Promise<CollectedRevenue[]> {
  const scoped =
    "customerId" in scope
      ? sql`p.customer_id = ${scope.customerId}`
      : sql`p.invoice_id in (select i.id from invoices i where i.subscription_id = ${scope.subscriptionId})`;
  const rows = (await withTenant(organizationId, (tx) =>
    tx.execute(sql`
      with paid as (
        select p.id, p.currency, p.amount_minor, p.invoice_id, p.created_at
        from payments p
        where p.status = 'succeeded' and ${scoped}
      ),
      refunded as (
        select r.payment_id, sum(r.amount_minor) as amount
        from refunds r
        where r.status = 'succeeded' and r.payment_id in (select id from paid)
        group by r.payment_id
      )
      select paid.currency,
             sum(paid.amount_minor) - coalesce(sum(refunded.amount), 0) as net,
             count(distinct paid.invoice_id) as invoices,
             min(paid.created_at) as first_paid_at
      from paid left join refunded on refunded.payment_id = paid.id
      group by paid.currency
      order by net desc
    `),
  )) as unknown as Array<{
    currency: string;
    net: string | number;
    invoices: string | number;
    first_paid_at: string | Date | null;
  }>;
  return rows.map((r) => ({
    currency: r.currency.trim(),
    amount_minor: Number(r.net),
    paid_invoices_count: Number(r.invoices),
    first_paid_at: r.first_paid_at ? new Date(r.first_paid_at) : null,
  }));
}
