/**
 * The FirstPromoter integration, end to end against a capture server.
 *
 * What this suite exists to catch, in the order the mistakes are easy to make:
 *  1. an organic signup — no referral id — must be SKIPPED, not POSTed. Sending it anyway is
 *     a 400 per customer and six attempts spent learning that, on the majority of traffic.
 *  2. a referred signup must carry the referral id the merchant captured. Without it there is
 *     no attribution and the integration is decorative.
 *  3. the sale amount is BEFORE tax and AFTER every discount — two stages of discount, one of
 *     which is already inside `subtotal_minor` and one of which is not. Every wrong version of
 *     this expression still produces a plausible number and pays the wrong commission.
 *  4. a 409 is a SUCCESS. It is the retry finding the commission already recorded; judging it
 *     by the default rule files a delivered event as failed.
 *  5. a 400 is terminal. Under the default rule it costs six attempts instead of one.
 *  6. the partner credential must never reach a transcript — the operator-facing Resend screen
 *     renders one verbatim.
 *  7. a partner integration is NOT a webhook endpoint: the org's own endpoints still get our
 *     envelope, and no partner call is ever queued in `webhook_deliveries`.
 *  8. disconnect settles pending deliveries `skipped`; reconnect reuses the same row.
 *
 * The capture server answers whatever the test tells it to next, so the verdict half is driven
 * rather than waited for.
 *
 *   pnpm verify:firstpromoter
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createDefinition } from "@/modules/custom-fields/service";
import { startTimeTravel, stopTimeTravel } from "@/modules/time-travel/service";
import { runWithClockScope } from "@/platform/clock";
import { importArchivalInvoice } from "@/modules/invoicing/import";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { createEndpoint } from "@/modules/webhooks/endpoints";
import { deliverPending } from "@/modules/webhooks/outbox";
import "@/modules/integrations/sink";
import {
  connectIntegration,
  disconnectIntegration,
  getIntegrationConnection,
} from "@/modules/integrations/connections";
import {
  deliverPendingIntegrations,
  listIntegrationDeliveries,
  redeliverIntegrationDelivery,
  requeueFailedIntegrationDeliveries,
} from "@/modules/integrations/outbox";
import { pushIntegration } from "@/modules/integrations/registry";
import {
  events,
  integrationConnections,
  integrationDeliveries,
  webhookDeliveries,
} from "@db/schema";
import { encryptCredentials } from "@/platform/secrets";

/**
 * The business whose clock we borrowed, so the `finally` can hand it back even when a check
 * throws. Time travel is GLOBAL state — `timeTravelledBusinessIds()` is read by the real
 * tick — so leaving one running would make this suite's failure mode depend on what runs next,
 * which is the thing sharding exists to prevent.
 */
let borrowedClock: { orgId: string; bizId: string } | null = null;

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);

/** Every request the "partner" received, in order. */
type Captured = { path: string; headers: Record<string, string>; body: Record<string, unknown> };
const captured: Captured[] = [];
/** What the capture server answers next — pushed by the test, shifted per request. */
const replies: number[] = [];

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    captured.push({
      path: req.url ?? "",
      headers: req.headers as Record<string, string>,
      body: raw ? JSON.parse(raw) : {},
    });
    const status = replies.shift() ?? 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        status < 300 ? { ok: true } : { ok: false, message: `stub refused ${status}` },
      ),
    );
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await createOrganization({ name: `FP Co ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "FP Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });

  /**
   * HERMETIC AGAINST THE DEV WORKER, which is not optional here.
   *
   * A running worker drains `webhook_deliveries` every 60s across every business, so without
   * this the suite races it: it claimed our rows (leaving them `pending` when we looked) or
   * delivered them itself, twice in five runs. Putting the business on a simulated clock is
   * the mechanism the engine already has for exactly this — `timeTravelledBusinessIds()` is
   * what the real tick excludes — and our own drains then run under `onlyBusinessId`, which is
   * the matching half of the same scope. Nothing else in the suite depends on the simulated
   * time; the genesis is simply now.
   */
  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: new Date() });
  borrowedClock = { orgId, bizId: biz.id };

  /**
   * The referral id is a CUSTOM FIELD, and a custom field must be defined before it can be
   * set — `validateAndCoerce` throws `Unknown custom field` otherwise. So defining `fp_tid` is
   * a real prerequisite of the integration, not test scaffolding, and it is asserted here so
   * the connect flow documents it.
   */
  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "customer",
    apiName: "fp_tid",
    label: "FirstPromoter referral id",
    dataType: "string",
  });

  const noKey = await connectIntegration({
    organizationId: orgId,
    business: { id: biz.id, livemode: "test" },
    provider: "firstpromoter",
    credentials: { apiKey: "k" },
  }).then(
    () => "accepted",
    (e: Error) => e.message,
  );
  ok(`a connection missing the account id is refused (got "${noKey}")`, /Account ID/i.test(noKey));

  const connected = await connectIntegration({
    organizationId: orgId,
    business: { id: biz.id, livemode: "test" },
    provider: "firstpromoter",
    credentials: { apiKey: `fp_secret_${RUN}`, accountId: `acct_${RUN}` },
  });
  // The capture server stands in for the partner: connect always stores the default URL.
  await withTenant(orgId, (tx) =>
    tx
      .update(integrationConnections)
      .set({ apiBase: base })
      .where(eq(integrationConnections.id, connected.id)),
  );
  const conn = (await getIntegrationConnection(orgId, biz.id, "firstpromoter"))!;
  ok(
    "a connection is created with the partner's event types",
    [
      "customer_created",
      "invoice_paid",
      "refund_created",
      "refund_settled",
      "subscription_canceled",
    ].every((t) =>
      (pushIntegration("firstpromoter")?.connect.eventTypes as readonly string[]).includes(t),
    ),
  );
  ok(
    "…and never stores the API key in the clear",
    !JSON.stringify(conn).includes(`fp_secret_${RUN}`) && conn.apiBase === base,
  );

  // A webhook endpoint in the same org: it gets our envelope, never a partner call.
  const hook = await createEndpoint({
    organizationId: orgId,
    businessId: biz.id,
    livemode: "test",
    url: `${base}/hook`,
  });

  /**
   * The v2 wire format is pinned by value below (Bearer + ACCOUNT-ID, no v1 header). Built
   * against v1 first, and every live call came back 401: the API VERSION was wrong.
   */
  const drain = () =>
    runWithClockScope({ onlyBusinessId: biz.id }, () => deliverPendingIntegrations(new Date()));
  const drainHooks = () =>
    runWithClockScope({ onlyBusinessId: biz.id }, () => deliverPending(new Date()));
  const deliveriesFor = async (eventPublicId: string) =>
    withTenant(orgId, async (tx) => {
      const rows = await tx
        .select({
          status: integrationDeliveries.status,
          attempts: integrationDeliveries.attempts,
          lastError: integrationDeliveries.lastError,
        })
        .from(integrationDeliveries)
        .innerJoin(events, eq(events.id, integrationDeliveries.eventId))
        .where(
          and(eq(events.publicId, eventPublicId), eq(integrationDeliveries.connectionId, conn.id)),
        );
      return rows;
    });

  // ── 1) An organic signup is SKIPPED, with no request made ──────────────────
  const organic = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `organic-${RUN}@example.com`,
  });
  const before = captured.length;
  await drain();
  ok("an organic signup POSTs nothing", captured.length === before);
  const organicEvent = await latestEvent(orgId, "customer_created", organic.publicId);
  const organicRows = organicEvent ? await deliveriesFor(organicEvent) : [];
  ok(
    "…and its delivery is settled 'skipped'",
    organicRows.every((r) => r.status === "skipped"),
  );
  ok(
    "…without spending an attempt",
    organicRows.every((r) => r.attempts === 0),
  );

  // ── 2) A referred signup carries the referral id ───────────────────────────
  const referred = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `referred-${RUN}@example.com`,
    customFields: { fp_tid: `tid_${RUN}` },
  });
  await drain();
  const signup = captured.find((c) => c.path === "/track/signup");
  ok("a referred signup POSTs /track/signup", !!signup);
  ok("…with the merchant's tracking id", signup?.body.tid === `tid_${RUN}`);
  ok("…identified by our customer id", signup?.body.uid === referred.publicId);
  ok(
    "…authenticated as a v2 bearer token",
    signup?.headers["authorization"] === `Bearer fp_secret_${RUN}`,
  );
  ok("…and carries the v2 account id header", signup?.headers["account-id"] === `acct_${RUN}`);
  ok("…and sends no v1 header at all", signup?.headers["x-api-key"] === undefined);

  // ── 3) The sale amount is pre-tax and post-discount ────────────────────────
  // ₹100 of goods, a ₹10 document-level discount, 18% GST on the ₹90 that remains.
  // Commissionable = 9000, NOT the 10620 total and NOT the 10000 subtotal.
  const inv = await importArchivalInvoice({
    organizationId: orgId,
    businessId: biz.id,
    customerId: referred.id,
    status: "paid",
    currency: "INR",
    subtotalMinor: 10000,
    totalMinor: 10620,
    amountDueMinor: 0,
    date: new Date(),
    paidAt: new Date(),
    metadata: {},
    lines: [
      { description: "Plan", quantity: 1, unitAmountMinor: 10000, amountMinor: 10000 },
      {
        description: "Launch discount",
        quantity: 1,
        unitAmountMinor: -1000,
        amountMinor: -1000,
        kind: "discount",
      },
      {
        description: "IGST 18%",
        quantity: 1,
        unitAmountMinor: 1620,
        amountMinor: 1620,
        kind: "tax",
      },
    ],
  });
  const saleEventId = await withTenant(orgId, async (tx) => {
    const e = await emitEvent(tx, {
      organizationId: orgId,
      businessId: biz.id,
      type: "invoice_paid",
      data: buildEventData("invoice_paid", { id: inv.publicId, currency: "INR" }),
    });
    return e.publicId;
  });
  await drain();
  const sale = captured.find((c) => c.path === "/track/sale");
  ok("an invoice_paid POSTs /track/sale", !!sale);
  ok(
    "a 2xx delivery keeps no last_error",
    (await deliveriesFor(saleEventId)).every(
      (r) => r.status === "delivered" && r.lastError == null,
    ),
  );
  ok(
    `…for the pre-tax, post-discount amount (got ${String(sale?.body.amount)}, want 9000)`,
    sale?.body.amount === 9000,
  );
  ok("…deduplicated by our event id", sale?.body.event_id === saleEventId);

  // ── 3b) A webhook endpoint gets our envelope; the partner is not a webhook ──
  await drainHooks();
  const hookCalls = captured.filter((c) => c.path === "/hook");
  ok("a webhook endpoint still receives our event envelope", hookCalls.length > 0);
  ok(
    "…and the envelope is not a partner call",
    hookCalls.every((c) => c.headers["account-id"] === undefined && c.body.amount === undefined),
  );
  const hookRows = await withTenant(orgId, (tx) =>
    tx.select({ endpointId: webhookDeliveries.endpointId }).from(webhookDeliveries),
  );
  ok(
    `no partner call is queued in webhook_deliveries (${hookRows.length} rows)`,
    hookRows.length > 0 && hookRows.every((r) => r.endpointId === hook.endpoint.id),
  );

  // ── 4) A duplicate (409) settles DELIVERED ─────────────────────────────────
  const dupEventId = await emitInvoicePaid(orgId, biz.id, inv.publicId);
  replies.push(409);
  await drain();
  const dupRows = await deliveriesFor(dupEventId);
  ok(
    "a 409 duplicate settles 'delivered'",
    dupRows.every((r) => r.status === "delivered"),
  );

  // ── 5) A rejected request (400) is terminal, not six attempts ──────────────
  const badEventId = await emitInvoicePaid(orgId, biz.id, inv.publicId);
  replies.push(400);
  await drain();
  const badRows = await deliveriesFor(badEventId);
  ok(
    "a 400 settles 'failed'",
    badRows.every((r) => r.status === "failed"),
  );
  ok(
    `…on the FIRST attempt (got ${String(badRows[0]?.attempts)})`,
    badRows.every((r) => r.attempts === 1),
  );
  // Without the partner's reply, a failure says only "400" and nobody can tell why.
  ok(
    `…and keeps what the partner said (got ${JSON.stringify(badRows[0]?.lastError)})`,
    badRows.every((r) => r.lastError?.includes("stub refused 400") === true),
  );

  // ── 6) The credential never reaches a transcript ───────────────────────────
  const latest = (await listIntegrationDeliveries(orgId, conn.id))[0];
  const resend = latest
    ? await redeliverIntegrationDelivery(orgId, conn.id, latest.delivery.id)
    : null;
  const sentHeaders = (resend?.transcript.request.headers ?? {}) as Record<string, string>;
  ok("a resend transcript masks the bearer token", sentHeaders["Authorization"] === "***");
  // The account id is deliberately NOT masked — the partner prints it openly, and seeing it is
  // how an operator tells two connected accounts apart.
  ok("…but shows the account id", sentHeaders["ACCOUNT-ID"] === `acct_${RUN}`);
  ok(
    "…and the key appears nowhere in it",
    !JSON.stringify(resend ?? {}).includes(`fp_secret_${RUN}`),
  );
  // The masking must not break the call itself — the partner still got the real key.
  ok(
    "…while the request that went out carried the real one",
    captured.at(-1)?.headers["authorization"] === `Bearer fp_secret_${RUN}`,
  );

  // ── 7) A v1-shaped endpoint SETTLES rather than stranding ──────────────────
  /**
   * The realistic upgrade hazard: a row connected before v2 support stored only `apiKey`, so
   * `authOf` throws. That throw used to escape `attemptDelivery` — `deliverPending` counted and
   * logged it but never touched the row, which stayed `pending` on its 60-second claim lease and
   * retried every minute forever with `attempts` stuck at 0. Settled `failed` now, terminally,
   * because the same event and endpoint throw identically on every pass.
   */
  const legacy = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .update(integrationConnections)
      .set({ credentialsEnc: encryptCredentials({ apiKey: "v1-only" }) })
      .where(eq(integrationConnections.id, conn.id))
      .returning({ id: integrationConnections.id });
    return row;
  });
  const legacyEventId = await emitInvoicePaid(orgId, biz.id, inv.publicId);
  const beforeLegacy = captured.length;
  await drain();
  const legacyRows = await deliveriesFor(legacyEventId);
  ok("a credential the integration rejects POSTs nothing", captured.length === beforeLegacy);
  ok(
    `…and settles 'failed' rather than retrying forever (got '${legacyRows[0]?.status}')`,
    !!legacy && legacyRows.length > 0 && legacyRows.every((r) => r.status === "failed"),
  );
  ok(
    "…counting the attempt, so it is visible in the history",
    legacyRows.every((r) => r.attempts === 1),
  );
  ok(
    "…with the reason on the row",
    legacyRows.every((r) => r.lastError?.includes("Connect it again") === true),
  );

  // ── 8) Requeue all failed ──────────────────────────────────────────────────
  /**
   * The backlog path, and the reason it is not `redeliverDelivery` in a loop: that one POSTs
   * inline for a live transcript, which on a backlog is one request holding a pooled connection
   * for 10s per dead delivery. This writes pending rows and lets the clock send them.
   */
  const failedBefore = await withTenant(orgId, async (tx) =>
    tx
      .select({ id: integrationDeliveries.id })
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.connectionId, conn.id),
          eq(integrationDeliveries.status, "failed"),
        ),
      ),
  );
  const again = await requeueFailedIntegrationDeliveries(orgId, conn.id);
  ok(
    `requeue queues every failed delivery (${again?.requeued} for ${failedBefore.length} failed)`,
    again?.requeued === failedBefore.length && failedBefore.length > 0,
  );
  // Immediately again: everything it just queued is now PENDING, so a second call must find
  // nothing — this is the double-delivery guard, and it is the whole risk of a bulk button.
  const twice = await requeueFailedIntegrationDeliveries(orgId, conn.id);
  ok(`…and a second call queues nothing (got ${twice?.requeued})`, twice?.requeued === 0);

  /**
   * A replay must not leave the log showing one event as two live failures. The replay INSERTS
   * a row, so the original has to be retired or it stays red forever — visually identical to a
   * delivery that still needs attention, which is what made a fixed integration look broken.
   */
  const afterRequeue = await withTenant(orgId, async (tx) =>
    tx
      .select({ status: integrationDeliveries.status })
      .from(integrationDeliveries)
      .where(eq(integrationDeliveries.connectionId, conn.id)),
  );
  // Not `superseded === requeued`: the manual Resend above retires its original too, so some
  // rows were already retired before this call. What must hold is that NO failed row survives
  // a replay — that is the one an operator cannot tell from a live failure.
  ok(
    `…retiring every row it replaced (${afterRequeue.filter((r) => r.status === "superseded").length} superseded, ${afterRequeue.filter((r) => r.status === "failed").length} failed left)`,
    afterRequeue.filter((r) => r.status === "failed").length === 0 &&
      afterRequeue.filter((r) => r.status === "superseded").length >= (again?.requeued ?? 0),
  );

  // ── 9) TWO failed rows for ONE event queue ONE replay ──────────────────────
  /**
   * The production shape: an endpoint that failed, was fixed, was replayed, and failed
   * differently accumulates a failed row PER cycle — a 401 before the fix and a 404 after.
   * The `NOT EXISTS` guard cannot see rows the same INSERT is producing, so without a
   * DISTINCT the event is queued once per failed row and sent twice. The partner's own
   * event_id dedup would answer the second 409 (which we map to delivered), so nothing is
   * double-credited — but it is a wasted call and two more rows in a log this exists to stop
   * bloating.
   */
  const dupEvent = await emitInvoicePaid(orgId, biz.id, inv.publicId);
  await withTenant(orgId, async (tx) => {
    const [ev] = await tx
      .select({ id: events.id })
      .from(events)
      .where(eq(events.publicId, dupEvent))
      .limit(1);
    // Two failed rows for the same event, exactly as a replay cycle leaves behind.
    await tx
      .update(integrationDeliveries)
      .set({ status: "failed", attempts: 1 })
      .where(eq(integrationDeliveries.eventId, ev!.id));
    await tx.insert(integrationDeliveries).values({
      organizationId: orgId,
      businessId: biz.id,
      eventId: ev!.id,
      connectionId: conn.id,
      status: "failed",
      attempts: 1,
      nextAttemptAt: new Date(),
    });
  });
  const dupFailed = await deliveriesFor(dupEvent);
  const dupQueued = await requeueFailedIntegrationDeliveries(orgId, conn.id);
  const dupAfter = await deliveriesFor(dupEvent);
  ok(
    `${dupFailed.length} failed rows for one event queue exactly ONE replay (queued ${dupQueued?.requeued})`,
    dupFailed.length === 2 && dupAfter.filter((r) => r.status === "pending").length === 1,
  );
  ok(
    "…and both old rows are retired",
    dupAfter.filter((r) => r.status === "superseded").length === 2 &&
      dupAfter.filter((r) => r.status === "failed").length === 0,
  );

  // Keep the list read exercised: the endpoint's history is how an operator sees any of this.
  const history = await listIntegrationDeliveries(orgId, conn.id);
  ok("deliveries are visible in the connection's history", history.length > 0);

  // ── 10) Disconnect settles pending deliveries 'skipped' ────────────────────
  const pendingBefore = await withTenant(orgId, (tx) =>
    tx
      .select({ id: integrationDeliveries.id })
      .from(integrationDeliveries)
      .where(
        and(
          eq(integrationDeliveries.connectionId, conn.id),
          eq(integrationDeliveries.status, "pending"),
        ),
      ),
  );
  const pendingIds = new Set(pendingBefore.map((r) => r.id));
  const off = await disconnectIntegration(orgId, biz.id, "firstpromoter");
  const afterOff = await withTenant(orgId, (tx) =>
    tx
      .select({ id: integrationDeliveries.id, status: integrationDeliveries.status })
      .from(integrationDeliveries)
      .where(eq(integrationDeliveries.connectionId, conn.id)),
  );
  ok("disconnect marks the connection disconnected", off?.status === "disconnected");
  ok(
    `…and settles every pending delivery 'skipped' (${pendingIds.size} were pending)`,
    pendingIds.size > 0 &&
      afterOff.filter((r) => pendingIds.has(r.id)).every((r) => r.status === "skipped") &&
      afterOff.every((r) => r.status !== "pending"),
  );

  // ── 11) Reconnect reuses the row, so the history stays ─────────────────────
  const again2 = await connectIntegration({
    organizationId: orgId,
    business: { id: biz.id, livemode: "test" },
    provider: "firstpromoter",
    credentials: { apiKey: `fp_secret2_${RUN}`, accountId: `acct_${RUN}` },
  });
  ok(
    "reconnect reuses the same connection row (same public id)",
    again2.id === conn.id && again2.publicId === conn.publicId && again2.status === "active",
  );
  ok(
    "…and keeps the delivery history",
    (await listIntegrationDeliveries(orgId, conn.id)).length >= history.length,
  );
}

/** The most recent event of a type whose resource is this public id. */
async function latestEvent(
  orgId: string,
  type: string,
  resourcePublicId: string,
): Promise<string | null> {
  return withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ publicId: events.publicId, data: events.data })
      .from(events)
      .where(eq(events.type, type));
    const match = rows.find((r) => {
      const d = r.data as Record<string, { id?: string }> | null;
      return Object.values(d ?? {}).some(
        (v) => v && typeof v === "object" && v.id === resourcePublicId,
      );
    });
    return match?.publicId ?? null;
  });
}

async function emitInvoicePaid(orgId: string, businessId: string, invoicePublicId: string) {
  return withTenant(orgId, async (tx) => {
    const e = await emitEvent(tx, {
      organizationId: orgId,
      businessId,
      type: "invoice_paid",
      data: buildEventData("invoice_paid", { id: invoicePublicId, currency: "INR" }),
    });
    return e.publicId;
  });
}

try {
  await main();
} finally {
  if (borrowedClock) {
    // Best-effort: a failure to hand the clock back must not replace the real failure above.
    await stopTimeTravel(borrowedClock).catch(() => {});
  }
  server.close();
  await closeDb();
}

let failed = 0;
for (const [name, pass] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "✅" : "❌"} ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
