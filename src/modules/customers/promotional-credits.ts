/**
 * Promotional-credit history — every movement of a customer's
 * `promotional_credit_balance`, read from the ledger.
 *
 * A movement is one ledger transaction touching the bucket: a manual add/deduct/set, a
 * wallet grant, an invoice drawing credit, a credit note restoring it. Its id IS the
 * ledger `transaction_id`. `credit_type` + `reference` come from
 * `promotional_credit_movements` (0312) and exist only for manual movements made since
 * then; every other movement reports them as null. `closing_balance_minor` is the
 * running balance in that currency after the movement, derived here, never stored.
 */
import { and, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businessTimezone } from "@/platform/business-tz";
import {
  clampLimit,
  filterConditions,
  isUuid,
  kindsFromSpecs,
  opsFromSpecs,
  parseCursor,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { PROMOTIONAL_CREDIT } from "@/modules/customers/balances-read";

export interface PromotionalCreditMovement {
  id: string;
  type: "increment" | "decrement";
  amountMinor: bigint;
  currency: string;
  closingBalanceMinor: bigint;
  description: string | null;
  creditType: string | null;
  reference: string | null;
  sourceType: string;
  sourceId: string;
  createdAt: Date;
}

const col = (name: string): SQL => sql.raw(`m.${name}`);

/** Filterable fields of the movement list, keyed by their API name. */
const SPECS: Record<string, FilterSpec> = {
  type: { column: col("type"), kind: "enum" },
  credit_type: { column: col("credit_type"), kind: "enum" },
  currency: { column: col("currency"), kind: "enum" },
  created_at: { column: col("created_at"), kind: "date" },
};
export const PROMO_MOVEMENT_FILTER_OPS = opsFromSpecs(SPECS);
export const PROMO_MOVEMENT_FILTER_KINDS = kindsFromSpecs(SPECS);

type Row = {
  transaction_id: string;
  type: "increment" | "decrement";
  amount_minor: string;
  currency: string;
  closing_minor: string;
  memo: string | null;
  credit_type: string | null;
  reference: string | null;
  source_type: string;
  source_id: string;
  created_at: string | Date;
};

const toMovement = (r: Row): PromotionalCreditMovement => ({
  id: r.transaction_id,
  type: r.type,
  amountMinor: BigInt(r.amount_minor),
  currency: r.currency,
  closingBalanceMinor: BigInt(r.closing_minor),
  description: r.memo,
  creditType: r.credit_type,
  reference: r.reference,
  sourceType: r.source_type,
  sourceId: r.source_id,
  createdAt: new Date(r.created_at),
});

/** The movements CTE, aliased `m`, for one customer. */
const movementsSql = (businessId: string, customerId: string): SQL => sql`
  WITH per_txn AS (
    SELECT le.transaction_id,
           le.currency,
           min(le.created_at) AS created_at,
           sum(CASE WHEN le.direction = 'credit' THEN le.amount_minor ELSE -le.amount_minor END) AS delta,
           max(le.memo) AS memo,
           max(le.source_type) AS source_type,
           max(le.source_id) AS source_id
      FROM ledger_entries le
     WHERE le.business_id = ${businessId}
       AND le.customer_id = ${customerId}
       AND le.account = ${PROMOTIONAL_CREDIT}
     GROUP BY le.transaction_id, le.currency
    HAVING sum(CASE WHEN le.direction = 'credit' THEN le.amount_minor ELSE -le.amount_minor END) <> 0
  ), m AS (
    SELECT p.transaction_id,
           CASE WHEN p.delta > 0 THEN 'increment' ELSE 'decrement' END AS type,
           abs(p.delta)::bigint AS amount_minor,
           p.currency,
           sum(p.delta) OVER (PARTITION BY p.currency ORDER BY p.created_at, p.transaction_id)::bigint AS closing_minor,
           p.memo,
           pcm.credit_type,
           pcm.reference,
           p.source_type,
           p.source_id,
           p.created_at
      FROM per_txn p
      LEFT JOIN promotional_credit_movements pcm ON pcm.ledger_transaction_id = p.transaction_id
  )`;

/** Newest first, offset-paged (a customer's movement count is small). */
export async function listPromotionalCreditMovements(
  organizationId: string,
  businessId: string,
  customerId: string,
  opts: { limit?: number; startingAfter?: string; filters?: ListFilter[] },
): Promise<ListPage<PromotionalCreditMovement>> {
  const limit = clampLimit(opts.limit);
  const { offset } = parseCursor(opts.startingAfter);
  return withTenant(organizationId, async (tx) => {
    const tz = await businessTimezone(tx, businessId);
    const conds = filterConditions(SPECS, opts.filters, tz);
    const where = conds.length ? sql`WHERE ${and(...conds)}` : sql``;
    const rows = (await tx.execute(sql`
      ${movementsSql(businessId, customerId)}
      SELECT m.* FROM m ${where}
      ORDER BY m.created_at DESC, m.transaction_id DESC
      LIMIT ${limit + 1} OFFSET ${offset}
    `)) as unknown as Row[];
    const total =
      offset === 0
        ? Number(
            (
              (await tx.execute(sql`
                ${movementsSql(businessId, customerId)}
                SELECT count(*)::int AS n FROM m ${where}
              `)) as unknown as Array<{ n: number }>
            )[0]?.n ?? 0,
          )
        : null;
    return toPage(rows.map(toMovement), limit, {
      keyset: false,
      offset,
      keyOf: (r) => r.id,
      total,
    });
  });
}

export async function getPromotionalCreditMovement(
  organizationId: string,
  businessId: string,
  customerId: string,
  movementId: string,
): Promise<PromotionalCreditMovement | null> {
  // Ids are ledger uuids; anything else is simply not found.
  if (!isUuid(movementId)) return null;
  return withTenant(organizationId, async (tx) => {
    const rows = (await tx.execute(sql`
      ${movementsSql(businessId, customerId)}
      SELECT m.* FROM m WHERE m.transaction_id = ${movementId}::uuid
    `)) as unknown as Row[];
    return rows[0] ? toMovement(rows[0]) : null;
  });
}

export function serializePromotionalCreditMovement(
  customerPublicId: string,
  m: PromotionalCreditMovement,
) {
  return {
    object: "promotional_credit_movement",
    id: m.id,
    customer: customerPublicId,
    type: m.type,
    amount_minor: Number(m.amountMinor),
    currency: m.currency,
    closing_balance_minor: Number(m.closingBalanceMinor),
    description: m.description,
    credit_type: m.creditType,
    reference: m.reference,
    source_type: m.sourceType,
    source_id: m.sourceId,
    created_at: m.createdAt.toISOString(),
  };
}
