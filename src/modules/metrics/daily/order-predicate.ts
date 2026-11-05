import { sql, type SQL } from "drizzle-orm";

/** The order predicate over an invoice alias `i`. */
export function isOrder(): SQL {
  return sql`i.status in ('posted', 'payment_due', 'not_paid', 'paid') and i.subscription_id is null
    and exists (select 1 from invoice_line_items ol left join prices op on op.id = ol.price_id
      where ol.invoice_id = i.id and ol.kind = 'one_time'
        and coalesce(op.grants_credit ->> 'kind', '') <> 'pack')
    and not exists (select 1 from customers rx where rx.id = i.customer_id and rx.exclude_from_reporting)`;
}
