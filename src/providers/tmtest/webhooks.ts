/**
 * TM Test Gateway async webhook delivery (C4).
 *
 * The gateway enqueues async events (late-failure reversals, slow-timeout
 * settlements) into `tmtest_outbound`. This pass delivers due events **through
 * the real inbound pipeline** — the same `handleProviderEvent` path an external
 * gateway's HTTP webhook flows through (dedup, reconciliation, late failures).
 * (We invoke the shared handler in-process rather than making a TCP hop; the HTTP
 * inbound route for external gateways is added in C8.)
 *
 *  - `tmtestWebhookPass(now)` — clock-driven: delivers events whose `deliver_after`
 *    has passed.
 *  - `advanceTmtest(orgId, now)` — the `/v1/tmtest/advance` simulator: flushes ALL
 *    pending events for the caller's org immediately, so verify suites don't sleep.
 */
import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { businesses } from "@db/schema";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { TmtestProvider } from "./index";
import * as store from "./store";
import type { TmtestOutbound } from "./store";

async function deliver(rows: TmtestOutbound[], now: Date): Promise<{ delivered: number }> {
  let delivered = 0;
  for (const row of rows) {
    // Claim before delivering (finale review): a travel step and the real tick
    // can both scan this row — exactly-once processing. Claim-first is right for
    // a TEST gateway: a crash between claim and inbound handling loses a
    // simulated webhook rather than double-mutating billing state.
    if (!(await store.claimOutbound(row.id, now))) continue;
    const provider = new TmtestProvider(row.businessId);
    // Feed the signed payload through normalizeWebhook (signature verification)
    // then the shared inbound handler (dedup + reconciliation).
    const events = await provider.normalizeWebhook({
      payload: JSON.stringify(row.payload),
      headers: { "x-tmtest-signature": row.signature },
    });
    for (const ev of events)
      await handleProviderEvent("tmtest", ev, { businessId: row.businessId, payload: row.payload });
    delivered++;
  }
  return { delivered };
}

/** Clock-driven: deliver events whose `deliver_after` has elapsed. */
export async function tmtestWebhookPass(now: Date): Promise<{ delivered: number }> {
  const pending = await store.listPendingOutbound(now);
  return deliver(pending, now);
}

/** Simulator: flush ALL pending events for the caller's org immediately. */
export async function advanceTmtest(
  organizationId: string,
  now: Date,
): Promise<{ delivered: number }> {
  const bizes = await systemDb
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.organizationId, organizationId));
  const ids = new Set(bizes.map((b) => b.id));
  const pending = (await store.listPendingOutbound(now, { all: true })).filter((r) =>
    ids.has(r.businessId),
  );
  return deliver(pending, now);
}
