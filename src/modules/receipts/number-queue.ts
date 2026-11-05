import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { NUMBER_JOB_PRIORITY } from "@/modules/invoicing/number-queue";

const log = createLogger("receipts");

/**
 * Ask for a `number_receipts` run for one business — the `number_invoices` pattern: one
 * pending job per business (`job_key`, run_at kept), one request in flight per business per
 * process. The clock tick re-requests any business still holding unnumbered receipts.
 */
const inFlight = new Map<string, { again: boolean }>();
export function requestReceiptNumbering(organizationId: string, businessId: string): void {
  const cur = inFlight.get(businessId);
  if (cur) {
    cur.again = true;
    return;
  }
  const state = { again: false };
  inFlight.set(businessId, state);
  void (async () => {
    do {
      state.again = false;
      try {
        await systemDb.execute(sql`select graphile_worker.add_job(
          'number_receipts',
          json_build_object('organizationId', ${organizationId}::text, 'businessId', ${businessId}::text),
          run_at => now() + interval '200 milliseconds',
          max_attempts => 3,
          job_key => ${"number_receipts:" + businessId},
          job_key_mode => 'preserve_run_at',
          priority => ${NUMBER_JOB_PRIORITY})`);
      } catch (e) {
        log.warn("receipt numbering request failed; the clock tick re-requests it", {
          event: "receipt_numbering_request_failed",
          businessId,
          error: (e as Error)?.message,
        });
      }
    } while (state.again);
    inFlight.delete(businessId);
  })();
}

/** Clock-tick sweep: re-request numbering for every business with receipts still unnumbered. */
export async function requestPendingReceiptNumbering(): Promise<number> {
  const rows = (await systemDb.execute(sql`
    select organization_id, business_id from receipts where number is null
    group by organization_id, business_id`)) as unknown as Array<{
    organization_id: string;
    business_id: string;
  }>;
  for (const r of rows) requestReceiptNumbering(r.organization_id, r.business_id);
  return rows.length;
}
