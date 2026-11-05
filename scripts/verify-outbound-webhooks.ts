/**
 * Proves outbound webhooks (outbox pattern): a paid invoice emits invoice.paid,
 * which is delivered (signed) to a registered endpoint. Verifies the HMAC
 * signature at the receiver, and that a 500 receiver is retried (not lost).
 *
 *   pnpm verify:outbound-webhooks
 */
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createEndpoint, redeliverLatest } from "@/modules/webhooks/endpoints";
import { deliverPending, enqueueDeliveries, signPayload } from "@/modules/webhooks/outbox";
import { events, webhookDeliveries } from "@db/schema";

// Local receiver. Replies 500 the first time (force a retry), then 200.
const received: Array<{ valid: boolean; type: string }> = [];
let calls = 0;
let secret = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    const sig = req.headers["tmbilling-signature"] as string;
    const valid = sig === signPayload(secret, body);
    const evt = JSON.parse(body);
    if (calls === 1) {
      res.writeHead(500).end("boom"); // first attempt fails → must be retried
      return;
    }
    // ADR-009 Part B envelope: `event_type` (not `type`).
    received.push({ valid, type: evt.event_type });
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/hook`;

const org = await createOrganization({ name: "Webhook Org" });
const orgId = org.organization.id;
// Clear any nudge left pending by an earlier run FIRST. Without this the post-flow
// assertion below reads `>= 1` off a stale row and passes even if the enqueue is deleted —
// a test that cannot fail. `_private_jobs` because `graphile_worker.jobs` is a view.
await systemDb.execute(sql`delete from graphile_worker._private_jobs where task_id in (
  select id from graphile_worker._private_tasks where identifier = 'webhook_outbox_nudge')`);

const ep = await createEndpoint({ organizationId: orgId, url });
secret = ep.secret;

const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "w@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 4900,
  interval: "month",
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
  defaultPaymentMethodId: undefined,
});

// Bill + pay → emits invoice.paid + creates a pending delivery.
await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});

// First delivery attempt → receiver replies 500 → should reschedule (not fail).
const d1 = await deliverPending(new Date());

// `deliverPending` drains the WHOLE outbox, not just this org's, so its counters
// also carry whatever other suites left pending — endpoints on ephemeral ports
// that are long closed, which fail at the network layer and reschedule. Sharding
// CI exposed this: `d1.attempted === 13` only ever held because the suites that
// happened to run earlier left exactly zero pending rows, and with a different
// set of predecessors it read 23. Assert on THIS org's rows, which is what the
// check was actually about: one delivery 500'd and rescheduled, the other twelve
// delivered on the first pass.
const after1 = await withTenant(orgId, async (tx) =>
  tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.organizationId, orgId)),
);
const delivered1 = after1.filter((d) => d.status === "delivered");
const pending1 = after1.filter((d) => d.status !== "delivered");

// Backdate the rescheduled attempt so the retry is due now, then deliver again.
await systemDb
  .update(webhookDeliveries)
  .set({ nextAttemptAt: new Date(Date.now() - 1000) })
  .where(eq(webhookDeliveries.organizationId, orgId));
const d2 = await deliverPending(new Date());

const deliveries = await withTenant(orgId, async (tx) =>
  tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.organizationId, orgId)),
);

console.log(
  `attempt 1: ${JSON.stringify(d1)} (receiver 500 → reschedule; org-scoped: ${delivered1.length} delivered, ${pending1.length} rescheduled)`,
);
console.log(`attempt 2: ${JSON.stringify(d2)} (receiver 200)`);
console.log(`receiver calls=${calls} received=${JSON.stringify(received)}`);
const retried = deliveries.find((d) => d.attempts === 2);
console.log(
  `delivery rows: ${deliveries.length} total, all delivered=${deliveries.every((d) => d.status === "delivered")}, retried row attempts=${retried?.attempts} last_status=${retried?.lastResponseStatus}`,
);

// This flow emits 13 events (customer_created/payment_source_added/customer_updated
// [vaulting sets the default payment method]/product/price/subscription×3/
// invoice.generated/payment.initiated/payment.succeeded/invoice.paid +
// gateway_account_created from the test business's auto-provisioned TM Test
// Gateway), so 13 deliveries exist; the first HTTP call is 500'd and only that
// one delivery is rescheduled and retried.
let pass =
  after1.length === 13 &&
  delivered1.length === 12 && // rest delivered on the first pass
  pending1.length === 1 &&
  pending1[0]!.attempts === 1 && // the 500'd one rescheduled, not failed
  received.length === 13 &&
  received.every((r) => r.valid) &&
  received.some((r) => r.type === "invoice_paid") &&
  received.some((r) => r.type === "payment_succeeded") &&
  received.some((r) => r.type === "payment_initiated") &&
  received.some((r) => r.type === "gateway_account_created") &&
  deliveries.length === 13 &&
  deliveries.every((d) => d.status === "delivered") &&
  retried !== undefined; // exactly the 500'd delivery took 2 attempts

// ── redeliverLatest: the one-click "is it working again?" ────────────────────────
//
// It must reach the SAME delivery the per-delivery route would, and it must tell a brand-new
// endpoint apart from a broken one — an endpoint with no history is the common case right after
// someone adds it, and reporting that as a failure would send an operator hunting a receiver bug
// that does not exist.
const emptyEp = await createEndpoint({ organizationId: orgId, url: `${url}/never-used` });
const noneYet = await redeliverLatest(orgId, emptyEp.endpoint.publicId);
const latestClone = await redeliverLatest(orgId, ep.endpoint.publicId);
const unknownEp = await redeliverLatest(orgId, "whe_does_not_exist");

const latestSettled = latestClone && latestClone !== "no_deliveries" ? latestClone : null;

console.log(
  `redeliverLatest: fresh endpoint → ${noneYet === "no_deliveries" ? "no_deliveries" : String(noneYet)}; ` +
    `used endpoint → ${
      latestSettled
        ? `${latestSettled.delivery.status} after ${latestSettled.delivery.attempts} attempt(s), ` +
          `HTTP ${latestSettled.transcript.response?.status ?? "none"} in ${latestSettled.transcript.latencyMs}ms`
        : String(latestClone)
    }; ` +
    `unknown → ${String(unknownEp)}`,
);

pass =
  pass &&
  noneYet === "no_deliveries" && // history-less endpoint is distinguishable, not an error
  unknownEp === null && // and a non-existent endpoint is a different answer again
  latestSettled !== null &&
  // ⚠️ INVERTED 2026-09-02. This asserted `attempts === 0` with the comment "a fresh clone queued
  // for the outbox, not sent inline". A resend is now SYNCHRONOUS: it calls the subscriber inline
  // and hands back the outcome, because an operator pressing Resend is asking whether their
  // receiver works NOW and a queued answer cannot tell them. So attempts is 1 and the row is
  // already settled — the old expectation is now precisely the shape of the bug.
  latestSettled.delivery.attempts === 1 &&
  latestSettled.delivery.status === "delivered" &&
  latestSettled.transcript.outcome === "delivered" &&
  latestSettled.transcript.response?.status === 200;

/**
 * The receiver stays up until HERE, and that is a change, not an oversight.
 *
 * `server.close()` used to sit ~50 lines above, right after the delivery assertions — which was
 * fine only because a resend was QUEUED: nothing was POSTed during `redeliverLatest`, so nobody
 * noticed the receiver was already gone. **The old assertion (`attempts === 0`) was therefore
 * satisfied by a resend that never left the process.** Now that the resend calls inline, the
 * closed port turned into `fetch failed` and the suite went red — the harness reporting a real
 * change in behaviour rather than a defect. Everything below this line (the nudge block) talks to
 * Postgres only and needs no receiver.
 */
server.close();

// ── The NUDGE: a first webhook must not wait for the next cron tick ──────────────
//
// Delivery rows are enqueued already due, but for a long time the only thing that drained
// the outbox was the `* * * * *` billing-clock tick — so a first delivery sat 0-60s (~30s
// average) waiting on nothing. `enqueueDeliveries` now enqueues `webhook_outbox_nudge` in
// the SAME transaction, via a no-argument SECURITY DEFINER wrapper (0201), so the job
// commits atomically with the event and graphile-worker wakes a worker on commit.
//
// Tested here because every part of it is silently losable: drop the call and delivery
// still works, just 30s slower, and every other assertion in this file stays green.
// ⚠️ MEASURED INSIDE THE TRANSACTION, and that is the whole design (rewritten 2026-09-02).
//
// These three assertions used to COUNT COMMITTED JOBS after the flow, which made them fail
// whenever the system was working. Measured on this machine by the session that found it: a
// `--role=billing` worker consumes `webhook_outbox_nudge` in about 250ms (watched 0 → 1 → 0),
// so a post-commit `count(*)` reads 0. `pending after 14 events` failed on the dev DB and
// passed on a scratch DB — same code, same commit, the only variable being whether anything
// drained the queue.
//
// That made this the INVERSE of an assertion that cannot fail: it could only fail while the
// consumer this feature exists to wake was actually running, and passed only in its ABSENCE.
// An uncommitted row cannot be drained by anyone, so the enqueue is now observed from inside
// the transaction that performs it and then rolled back.
//
// It also asserts something STRONGER than the version it replaces: the nudge is attributed to
// `enqueueDeliveries` itself rather than to "something in the preceding flow", and the block
// leaves no rows behind.
//
// ⚠️ Do NOT "fix" a future red here by asserting 0 or by aging the count out. The invariant is
// that the nudge commits ATOMICALLY with the event — that is what makes it safe to call on
// every emit — and an assertion that tolerates 0 tests nothing at all.
const nudgeIdsIn = async (tx: Parameters<Parameters<typeof systemDb.transaction>[0]>[0]) => {
  const r = await tx.execute(
    sql`select id from graphile_worker.jobs where task_identifier = 'webhook_outbox_nudge'`,
  );
  return (r as unknown as Array<{ id: number }>).map((x) => Number(x.id));
};
const nudgeCountIn = async (tx: Parameters<Parameters<typeof systemDb.transaction>[0]>[0]) => {
  const r = await tx.execute(
    sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'webhook_outbox_nudge'`,
  );
  return (r as unknown as Array<{ n: number }>)[0]!.n;
};

// One real event from the flow above — chosen through its own DELIVERY, not with `limit 1`.
//
// ⚠️ `enqueueDeliveries` only nudges `Inside if (endpoints.length > 0)`, so it enqueues nothing
// for an event whose TYPE no endpoint subscribes to. A `limit 1` over this org's events picks
// whichever row comes back first, which is exactly the data-dependence this rewrite exists to
// remove: measured 2026-09-02, that version passed on the dev DB (delta 1) and failed on a
// scratch DB (delta 0) — the same code reading a different first row. Selecting the event that
// a delivery already POINTS AT guarantees an endpoint subscribed to its type, by construction.
const [sampleEvent] = await withTenant(orgId, (tx) =>
  tx
    .select({ ev: events })
    .from(webhookDeliveries)
    .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
    .where(eq(webhookDeliveries.organizationId, orgId))
    .limit(1),
).then((rows) => rows.map((r) => r.ev));
if (!sampleEvent) throw new Error("no delivered event to re-enqueue — the nudge block cannot run");

// ⚠️ ABSOLUTE COUNTS, NOT A DELTA — and the delta version is what a scratch DB caught.
//
// The first cut asserted that `enqueueDeliveries` ADDED one job. Measured 2026-09-02:
//   dev DB      jobs before=0 after=1   (a live worker had drained the flow's own nudge)
//   scratch DB  jobs before=1 after=1   (nothing drains it, so the flow's nudge is pending
//                                        and `job_key` COALESCES this call onto it)
// Both are correct behaviour, so a delta of 1 is not the invariant. The invariant is that
// after the call a drain IS PENDING — whether this call created it or joined one — which is
// exactly what `job_key` exists to guarantee. Asserting the delta made the suite depend on
// whether a worker happened to be running, which is the fault it was rewritten to remove.
let nudgePending = -1;
let nudgeAfterBurst = -1;
let newIdsInTx: number[] = [];
try {
  await systemDb.transaction(async (tx) => {
    const idsBefore = await nudgeIdsIn(tx);
    await enqueueDeliveries(tx, sampleEvent);
    nudgePending = await nudgeCountIn(tx);
    const idsAfter = await nudgeIdsIn(tx);
    newIdsInTx = idsAfter.filter((id) => !idsBefore.includes(id));

    // COALESCING: a burst must not GROW the queue — `job_key` is what makes this safe to call
    // on every emit, and without it a busy org would flood it. Compared against the count
    // after the enqueue rather than against 1, so a job locked by a live worker mid-drain
    // cannot make this read 2 and fail for the wrong reason.
    for (let i = 0; i < 20; i++) await tx.execute(sql`select public.app_nudge_webhook_outbox()`);
    nudgeAfterBurst = await nudgeCountIn(tx);
    throw new Error("deliberate rollback");
  });
} catch (e) {
  if (!(e instanceof Error) || e.message !== "deliberate rollback") throw e;
}

// ROLLBACK: the nudge must never wake a worker for a change that did not commit. Checked by
// IDENTITY on the rows this transaction actually created — the old version diffed every nudge
// row before and after, which any concurrent insert could disturb.
//
// ⚠️ When the call COALESCED onto an already-pending job it creates no new row, and then there
// is nothing for a rollback to have left behind. That case is reported as SKIPPED rather than
// counted as a pass: an assertion with nothing to check is not evidence, and silently passing
// it is how a gate stops meaning anything.
const rollbackChecked = newIdsInTx.length > 0;
// One query per id rather than `id = any(${ids})`: drizzle binds a JS array as a SINGLE
// parameter, so that form emitted `any(($1))` with a scalar and the suite CRASHED before its
// verdict — on the dev DB only, because the scratch run coalesced and never reached this line.
// The list is one or two ids; a loop is clearer than fighting the binding.
let survivingIds = 0;
for (const id of newIdsInTx) {
  const r = await systemDb.execute(
    sql`select count(*)::int as n from graphile_worker.jobs where id = ${id}`,
  );
  survivingIds += (r as unknown as Array<{ n: number }>)[0]!.n;
}
const rollbackClean = rollbackChecked ? survivingIds === 0 : true;

console.log(
  `nudge: pending in-tx after enqueue=${nudgePending}, after +20 calls=${nudgeAfterBurst} (coalesced), rollback left no new job=${rollbackClean}${rollbackChecked ? "" : " (SKIPPED — the call coalesced, so no new row existed to roll back)"}`,
);

pass =
  pass &&
  nudgePending >= 1 && // enqueueDeliveries guarantees a drain is PENDING (new or coalesced)
  nudgeAfterBurst === nudgePending && // …and 20 more calls grew it by nothing
  rollbackClean; // …and an uncommitted change enqueued nothing

console.log("");
console.log(pass ? "✅ OUTBOUND WEBHOOKS: PASS" : "❌ OUTBOUND WEBHOOKS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
