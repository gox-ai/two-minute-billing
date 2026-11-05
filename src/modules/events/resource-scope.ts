import { sql, type Column, type SQL } from "drizzle-orm";

/**
 * "Everything this customer owns", as a resource-id set.
 *
 * `events` and `audit_logs` both point at what they describe by (resource_type,
 * public id) and nothing else — so scoping either stream to a customer means
 * enumerating the public ids that hang off that customer. The customer page shows
 * exactly this: the subscription, invoice and payment events of the customer's
 * life, not just the handful written against the customer record.
 *
 * It lives in the events module because that (type, id) pointer is its vocabulary;
 * `audit` imports it rather than keeping a second copy that would drift the day a
 * new customer-owned table appears.
 *
 * RLS scopes every table below to the caller's org, so no organization predicate
 * is needed here. `businessId` narrows the customer lookup itself: a customer
 * public id is unique per business, so the org-level stream would otherwise match
 * a same-named customer in a sibling business.
 */
export function ownedByCustomer(
  resourceId: Column,
  customerPublicId: string,
  businessId?: string,
): SQL {
  const cust = businessId
    ? sql`SELECT id FROM customers WHERE public_id = ${customerPublicId} AND business_id = ${businessId}`
    : sql`SELECT id FROM customers WHERE public_id = ${customerPublicId}`;
  return sql`${resourceId} IN (
    WITH c AS (${cust})
    SELECT ${customerPublicId}::text
    UNION ALL SELECT public_id FROM subscriptions   WHERE customer_id IN (SELECT id FROM c)
    UNION ALL SELECT public_id FROM invoices        WHERE customer_id IN (SELECT id FROM c)
    UNION ALL SELECT public_id FROM credit_notes    WHERE customer_id IN (SELECT id FROM c)
    UNION ALL SELECT public_id FROM transactions    WHERE customer_id IN (SELECT id FROM c)
    UNION ALL SELECT public_id FROM payments        WHERE customer_id IN (SELECT id FROM c)
    UNION ALL SELECT public_id FROM payment_methods WHERE customer_id IN (SELECT id FROM c)
    UNION ALL SELECT public_id FROM payment_intents WHERE customer_id IN (SELECT id FROM c)
    UNION ALL SELECT public_id FROM disputes        WHERE customer_id IN (SELECT id FROM c)
    -- A refund hangs off its payment, an attempt off its intent: both reach the
    -- customer one hop out, and both are on this customer's money.
    UNION ALL SELECT r.public_id FROM refunds r
      JOIN payments p ON p.id = r.payment_id
      WHERE p.customer_id IN (SELECT id FROM c)
    UNION ALL SELECT a.public_id FROM payment_attempts a
      JOIN payment_intents i ON i.id = a.payment_intent_id
      WHERE i.customer_id IN (SELECT id FROM c)
  )`;
}
