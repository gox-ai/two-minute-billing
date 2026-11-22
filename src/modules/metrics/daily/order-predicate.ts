import { sql, type SQL } from "drizzle-orm";

/** The order rule over an invoice alias, without the reporting filter. */
export function orderRuleOn(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`${a}.status in ('posted', 'payment_due', 'not_paid', 'paid') and ${a}.subscription_id is null
    and exists (select 1 from invoice_line_items ol left join prices op on op.id = ol.price_id
      where ol.invoice_id = ${a}.id and ol.kind = 'one_time'
        and coalesce(op.grants_credit ->> 'kind', '') <> 'pack')`;
}

/** The order predicate over an invoice alias `i`. */
export function isOrder(): SQL {
  return sql`${orderRuleOn("i")}
    and not exists (select 1 from customers rx where rx.id = i.customer_id and rx.exclude_from_reporting)`;
}
