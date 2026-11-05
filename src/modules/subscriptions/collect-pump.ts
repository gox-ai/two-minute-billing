import { setTimeout as sleep } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { runWithEventContext } from "@/platform/event-context";
import { createLogger } from "@/platform/logger";
import { isShuttingDown } from "@/platform/shutdown";
import { isValidTraceId, newTraceId, withTraceContext } from "@/platform/trace";
import { invoices } from "@db/schema";
import { collectRenewalInvoice, recordFailureOnTick } from "./renewal";
import { retryDueInvoice } from "./dunning";

const log = createLogger("collect-pump");

/** Most rows one claim leases, and how long a lease lasts before a crashed claim comes due again. */
const CLAIM_MAX = 100;
const LEASE = sql`interval '10 minutes'`;

type Due = {
  id: string;
  organization_id: string;
  business_id: string;
  subscription_id: string | null;
  /** Set by the dunning pass: a retry, not a first collection. */
  dunning: boolean;
  /** The tick that handed this invoice over; the charge joins its trace. */
  collect_trace_id: string | null;
};

async function claim(n: number): Promise<Due[]> {
  return (await systemDb.execute(sql`
    update invoices set collect_due_at = now() + ${LEASE}
    where id in (select id from invoices where collect_due_at <= now()
                 order by collect_due_at limit ${n} for update skip locked)
    returning id, organization_id, business_id, subscription_id, collect_trace_id,
              (status = 'payment_due' and next_attempt_at is not null) dunning`)) as unknown as Due[];
}

async function collectOne(r: Due): Promise<void> {
  try {
    await runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, () =>
      withTraceContext(
        r.collect_trace_id && isValidTraceId(r.collect_trace_id)
          ? { traceId: r.collect_trace_id, inherited: true }
          : { traceId: newTraceId("job") },
        async () => {
          if (!r.dunning) return collectRenewalInvoice(r.organization_id, r.id);
          await retryDueInvoice(
            {
              id: r.id,
              organizationId: r.organization_id,
              businessId: r.business_id,
              subscriptionId: r.subscription_id,
            },
            new Date(),
          );
        },
      ),
    );
    await systemDb.execute(
      sql`update invoices set collect_due_at = null, collect_trace_id = null where id = ${r.id}`,
    );
  } catch (e) {
    log.recurringError(`renewal_collect_failed:${r.id}`, e, {
      event: "renewal_collect_failed",
      invoiceId: r.id,
      organizationId: r.organization_id,
    });
    // Retried in five minutes rather than at the lease's end, and recorded where a tick's are.
    await systemDb
      .update(invoices)
      .set({ collectDueAt: sql`now() + interval '5 minutes'` })
      .where(eq(invoices.id, r.id))
      .catch(() => {});
    await recordFailureOnTick({
      organization: r.organization_id,
      business: r.business_id,
      invoice: r.id,
      ...(r.subscription_id ? { subscription: r.subscription_id } : {}),
      step: r.dunning ? "dunning_retry" : "collection",
      message: (e as Error)?.message ?? String(e),
    }).catch(() => {});
  }
}

/**
 * Charge invoices marked `collect_due_at` (first collections of batch-numbered renewals, and
 * dunning retries the pass handed over), up to `lanes` at a time, until
 * shutdown. One claimer per process leases only as many rows as there are free lanes, so an
 * idle pump costs one query a second. Not one graphile job per invoice: a backlog of hours of
 * charges in the job table slowed every worker's job lookup (D4).
 */
export function startCollectionPump(
  lanes: number,
  opts: { idleMs?: number } = {},
): { done: Promise<void> } {
  const idleMs = opts.idleMs ?? 1000;
  const active = new Set<Promise<void>>();
  const done = (async () => {
    while (!isShuttingDown()) {
      const free = lanes - active.size;
      if (free <= 0) {
        await Promise.race(active);
        continue;
      }
      let rows: Due[];
      try {
        rows = await claim(Math.min(free, CLAIM_MAX));
      } catch (e) {
        log.warn("collection claim failed", { event: "collect_claim_failed", error: String(e) });
        await sleep(1000);
        continue;
      }
      if (rows.length === 0) {
        // In one-second steps, so a long idle wait never holds up a shutdown.
        for (let waited = 0; waited < idleMs && !isShuttingDown(); waited += 1000)
          await sleep(1000);
        continue;
      }
      for (const r of rows) {
        const p: Promise<void> = collectOne(r).finally(() => active.delete(p));
        active.add(p);
      }
    }
    await Promise.all(active);
  })();
  return { done };
}
