/**
 * Pure balance READS for the customer three-bucket credit model (CUST-2 / D1).
 * Split out of `balances.ts` so event snapshot loaders (`events/content.ts` via
 * `customers/serialize.ts`) can import balance data WITHOUT pulling in
 * `balances.ts`'s emitEvent-using writers — importing that file would close a
 * cycle (serialize → balances → events/emit → events/content → serialize).
 * This file must never import `@/modules/events/emit`.
 */
import { and, eq, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { subscriptions } from "@db/schema";
import { createLogger } from "@/platform/logger";

const log = createLogger("customers");

export const PROMOTIONAL_CREDIT = "promotional_credit_balance";
export const REFUNDABLE_CREDIT = "refundable_credit_balance";
export const EXCESS_PAYMENT = "excess_payment_balance";
/** Excess credit drawn for a refund whose payout is in flight (`refunds/excess.ts`). */
export const EXCESS_REFUND_PENDING = "excess_refund_pending";

export type CreditBucket =
  | typeof PROMOTIONAL_CREDIT
  | typeof REFUNDABLE_CREDIT
  | typeof EXCESS_PAYMENT;

export interface CustomerBalances {
  promotional: bigint;
  refundable: bigint;
  excess: bigint;
}

/**
 * Serialize all bucket reads-then-draws for one customer. EVERY code path that
 * reads a bucket balance and then posts a draw against it MUST take this lock
 * first, inside the same transaction — otherwise two concurrent drawers both see
 * the same balance and over-spend it (review finding, 2026-07-04). The lock is
 * transaction-scoped (released automatically at commit/rollback).
 */
export async function lockCustomerBalances(tx: Tx, customerId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${customerId}::text, 7401))`);
}

/** Available (credit-normal) balance of one bucket for a customer+currency, ≥ 0. */
export async function bucketBalance(
  tx: Tx,
  customerId: string,
  account: CreditBucket,
  currency: string,
): Promise<bigint> {
  const res = await tx.execute(sql`
    select coalesce(sum(
      case when direction = 'credit' then amount_minor else -amount_minor end
    ), 0)::bigint as bal
    from ledger_entries
    where customer_id = ${customerId}
      and account = ${account}
      and currency = ${currency.toUpperCase()}
  `);
  const row = (res as unknown as Array<{ bal: string | number }>)[0];
  const bal = BigInt(row?.bal ?? 0);
  if (bal < 0n) {
    // Must be impossible with the advisory lock; if it ever fires, money leaked.
    log.error("LEDGER INTEGRITY: a customer balance bucket is NEGATIVE — over-drawn credit", {
      event: "ledger_bucket_negative",
      account,
      customerId,
      balanceMinor: bal,
      currency,
    });
  }
  return bal > 0n ? bal : 0n;
}

/** The three bucket balances for one customer+currency (bigints). */
export async function bucketBalancesForCurrency(
  organizationId: string,
  customerId: string,
  currency: string,
  tx?: Tx,
): Promise<CustomerBalances> {
  const run = async (t: Tx): Promise<CustomerBalances> => ({
    promotional: await bucketBalance(t, customerId, PROMOTIONAL_CREDIT, currency),
    refundable: await bucketBalance(t, customerId, REFUNDABLE_CREDIT, currency),
    excess: await bucketBalance(t, customerId, EXCESS_PAYMENT, currency),
  });
  return tx ? run(tx) : withTenant(organizationId, run);
}

/**
 * Total spendable customer credit across all three buckets, one currency. A
 * convenience for callers/tests that just want "how much credit does this
 * customer have" without the bucket breakdown.
 */
export async function customerCreditBalance(
  organizationId: string,
  customerId: string,
  currency: string,
  tx?: Tx,
): Promise<bigint> {
  const b = await bucketBalancesForCurrency(organizationId, customerId, currency, tx);
  return b.promotional + b.refundable + b.excess;
}

/**
 * All three balances per currency for a customer — the read model behind the
 * customer API `balances[]` and reconciliation. Any currency with a nonzero
 * bucket appears; buckets default to 0.
 */
export async function getCustomerBalances(
  organizationId: string,
  customerId: string,
): Promise<Record<string, { promotional: number; refundable: number; excess: number }>> {
  return withTenant(organizationId, async (tx) => {
    const rows = (await tx.execute(sql`
      select currency, account,
             coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::bigint as bal
      from ledger_entries
      where customer_id = ${customerId}
        and account in (${PROMOTIONAL_CREDIT}, ${REFUNDABLE_CREDIT}, ${EXCESS_PAYMENT})
      group by currency, account
    `)) as unknown as Array<{ currency: string; account: string; bal: string | number }>;
    const out: Record<string, { promotional: number; refundable: number; excess: number }> = {};
    const slot = (cur: string) => (out[cur] ??= { promotional: 0, refundable: 0, excess: 0 });
    for (const r of rows) {
      const bal = Number(r.bal);
      if (bal === 0) continue;
      const s = slot(r.currency);
      if (r.account === PROMOTIONAL_CREDIT) s.promotional = Math.max(0, bal);
      else if (r.account === REFUNDABLE_CREDIT) s.refundable = Math.max(0, bal);
      else if (r.account === EXCESS_PAYMENT) s.excess = Math.max(0, bal);
    }
    return out;
  });
}

/**
 * Per-currency MRR (sum of active/in_trial subscriptions' cached MRR) for a
 * customer — pure read, kept alongside the balance reads so `loadCustomerSnapshot`
 * can build the full `balances` financials without importing `customers/service.ts`.
 */
export async function getCustomerMrr(
  organizationId: string,
  customerId: string,
): Promise<Record<string, number>> {
  return withTenant(organizationId, async (tx) => {
    const mrrRows = await tx
      .select({ currency: subscriptions.currency, mrr: subscriptions.mrr })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.customerId, customerId),
          sql`${subscriptions.status} in ('active','in_trial')`,
        ),
      );
    const mrr: Record<string, number> = {};
    for (const r of mrrRows) {
      if (r.mrr == null) continue;
      mrr[r.currency] = (mrr[r.currency] ?? 0) + Number(r.mrr);
    }
    return mrr;
  });
}
