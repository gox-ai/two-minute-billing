import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";

const log = createLogger("invoicing");

/** Ahead of renewals (10), so invoices are numbered and charged while the backlog drains. */
export const NUMBER_JOB_PRIORITY = 5;

/**
 * Ask for a `number_invoices` run for one business. One pending job per business (`job_key`,
 * run_at kept), and one request in flight per business per process, because every request
 * writes the same job row. The clock tick re-requests any business still holding unnumbered
 * invoices, so a lost request delays numbering by a minute at most.
 */
const inFlight = new Map<string, { again: boolean }>();
export function requestInvoiceNumbering(organizationId: string, businessId: string): void {
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
          'number_invoices',
          json_build_object('organizationId', ${organizationId}::text, 'businessId', ${businessId}::text),
          run_at => now() + interval '200 milliseconds',
          max_attempts => 3,
          job_key => ${"number_invoices:" + businessId},
          job_key_mode => 'preserve_run_at',
          priority => ${NUMBER_JOB_PRIORITY})`);
      } catch (e) {
        log.warn("invoice numbering request failed; the clock tick re-requests it", {
          event: "invoice_numbering_request_failed",
          businessId,
          error: (e as Error)?.message,
        });
      }
    } while (state.again);
    inFlight.delete(businessId);
  })();
}

/** Clock-tick sweep: re-request numbering for every business with invoices still waiting. */
export async function requestPendingInvoiceNumbering(): Promise<number> {
  const rows = (await systemDb.execute(sql`
    select organization_id, business_id from invoices where awaiting_number
    group by organization_id, business_id`)) as unknown as Array<{
    organization_id: string;
    business_id: string;
  }>;
  for (const r of rows) requestInvoiceNumbering(r.organization_id, r.business_id);
  return rows.length;
}
