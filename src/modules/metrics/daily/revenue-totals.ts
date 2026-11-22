import type { Tx } from "@/platform/db";
import { billedRevenueByInvoice } from "@/modules/payments/attribution";

/**
 * NET billed revenue per invoice (the `revenue_billed` rule: discounts and credits off, credit
 * notes not, since a note is dated by its own issue date), memoised across runs.
 *
 * The lifetime measures fold every billed invoice up to a period's end, and a backfill asks
 * that for hundreds of days. A billed invoice's lines do not change, so its total is read
 * once per process. Only ids that a billed-status query returned may be passed in.
 */
const MAX_CACHED = 300_000;
const totals = new Map<string, bigint>();

export async function revenueTotalsByInvoice(
  tx: Tx,
  invoiceIds: readonly string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const missing: string[] = [];
  for (const id of invoiceIds) {
    const v = totals.get(id);
    if (v === undefined) missing.push(id);
    else out.set(id, v);
  }
  if (missing.length === 0) return out;
  const folded = await billedRevenueByInvoice(tx, missing);
  for (const id of missing) {
    const v = (folded.get(id)?.lines ?? []).reduce((s, l) => s + l.amountMinor, 0n);
    out.set(id, v);
    if (totals.size < MAX_CACHED) totals.set(id, v);
  }
  return out;
}
