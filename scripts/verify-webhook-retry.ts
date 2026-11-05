/**
 * A webhook whose PROCESSING fails must be retried, not stranded.
 *
 * The bug this pins (found 2026-08-01, fixed same day): `handleProviderEvent` caught
 * every handler error, recorded `outcome='error'` and returned normally, so the route
 * answered **200**. Every gateway treats 2xx as "handled" and stops redelivering — so a
 * transient failure while booking a `charge.refunded` meant the money had moved at the
 * gateway, our ledger never learned, and nothing ever tried again. There was no replay
 * job either.
 *
 * Two halves, and the fix is worthless without both:
 *  1. the route answers **502** when any handler errored, so the gateway redelivers;
 *  2. `handleProviderEvent` REPROCESSES a previously-errored event instead of deduping
 *     it — otherwise the redelivery is swallowed by our own idempotency and the retry
 *     achieves exactly nothing.
 *
 * Asserted end-to-end through the real HTTP route, using the TM Test Gateway so the
 * failure can be induced deterministically: `disputes.currency` is `char(3) NOT NULL`
 * and the adapter passes the provider's value through unvalidated, so an over-long
 * currency raises on insert. Note an *uncorrelated* dispute is NOT a failure — it is
 * recorded best-effort and lands `ignored`, which is why it cannot be the trigger.
 *
 * Phase 6a (`ourRetry`): the same failure also queues OUR retry job, a redelivery racing that
 * job books once, the last failed try marks the row, and the clock pass re-queues an orphan.
 *
 *   pnpm verify:webhook-retry
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import {
  PROCESS_GATEWAY_WEBHOOK_TASK,
  PROCESS_MAX_ATTEMPTS,
  RETRIES_EXHAUSTED_NOTE,
  processStoredGatewayWebhook,
  replayGatewayWebhook,
  requeueStrandedGatewayWebhooks,
  storedDeliveryJobKey,
  type StoredDeliveryJob,
} from "@/modules/gateway/inbound";
import { providerEvents, gatewayAccounts, disputes } from "@db/schema";
import { signTmtest } from "@/providers/tmtest/signing";
import type { NormalizedProviderEvent } from "@/providers/types";

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);

const app = await buildApp({ logger: false });

async function main() {
  const org = await createOrganization({ name: `Webhook Retry Co ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "WR Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });

  const outcomeOf = async (id: string) => {
    const [row] = await systemDb
      .select({ outcome: providerEvents.outcome })
      .from(providerEvents)
      .where(and(eq(providerEvents.providerKey, "tmtest"), eq(providerEvents.providerEventId, id)))
      .limit(1);
    return row?.outcome ?? null;
  };

  // ── 1) A handler error is recorded as `error`, not silently swallowed ──────
  // Deterministic failure: `disputes.currency` is `char(3) NOT NULL`, so an over-long
  // currency raises on insert. (An *uncorrelated* dispute is NOT a failure — it is
  // recorded best-effort and lands `ignored`, which is why that cannot be the trigger.)
  const failingId = `evt_fail_${RUN}`;
  const failing: NormalizedProviderEvent = {
    providerEventId: failingId,
    type: "dispute.created",
    providerDisputeId: `dp_${RUN}`,
    providerChargeId: `ch_missing_${RUN}`,
    disputeAmountMinor: 1000n,
    disputeCurrency: "NOT_A_CURRENCY",
    occurredAt: new Date(),
    raw: {},
  };
  const first = await handleProviderEvent("tmtest", failing, { businessId: biz.id });
  ok(`a failing handler yields 'error' (got '${first}')`, first === "error");
  ok("…and the row records outcome=error", (await outcomeOf(failingId)) === "error");

  // ── 2) THE FIX: a redelivery of an errored event is REPROCESSED ────────────
  // Before the fix this returned 'duplicate' and the event was stranded forever.
  const second = await handleProviderEvent("tmtest", failing, { businessId: biz.id });
  ok(
    `redelivery of an errored event is reprocessed, not deduped (got '${second}')`,
    second === "error",
  );

  // ── 3) A SETTLED event is still deduped — idempotency must not regress ─────
  const okId = `evt_ok_${RUN}`;
  const benign: NormalizedProviderEvent = {
    providerEventId: okId,
    // Unmapped type → no branch runs → 'ignored', a settled outcome.
    type: "unknown",
    occurredAt: new Date(),
    raw: {},
  };
  const firstOk = await handleProviderEvent("tmtest", benign, { businessId: biz.id });
  const replayOk = await handleProviderEvent("tmtest", benign, { businessId: biz.id });
  ok(`a settled event processes once (got '${firstOk}')`, firstOk === "ignored");
  ok(`…and its replay is a duplicate (got '${replayOk}')`, replayOk === "duplicate");

  // ── 4) The ROUTE answers non-2xx so the gateway actually redelivers ────────
  // tmtest signs with our own secret, so a well-formed delivery reaches the handler.
  //
  // Inducing the failure: through the route the business ALWAYS resolves (from the
  // gateway account), so an uncorrelated dispute is handled best-effort rather than
  // throwing. Instead send a currency the column cannot hold — `disputes.currency` is
  // `char(3) NOT NULL` and the adapter passes the provider's value through unvalidated,
  // so the insert raises. That is a fair stand-in for the real cases (a transient DB
  // failure, or a provider sending something we cannot store).
  const [acct] = await systemDb
    .select()
    .from(gatewayAccounts)
    .where(eq(gatewayAccounts.businessId, biz.id))
    .limit(1);
  const payload = {
    id: `evt_route_${RUN}`,
    type: "dispute.created",
    data: {
      provider_dispute_id: `dp_route_${RUN}`,
      provider_charge_id: `ch_missing_route_${RUN}`,
      amount_minor: 1000,
      currency: "NOT_A_CURRENCY",
    },
  };
  const res = await app.inject({
    method: "POST",
    url: `/v1/gateway_webhooks/tmtest?id=${acct!.publicId}`,
    headers: {
      "idempotency-key": crypto.randomUUID(),
      "content-type": "application/json",
      "x-tmtest-signature": signTmtest(payload),
    },
    payload: JSON.stringify(payload),
  });
  // The gateway must be told to come back. 200 here is the whole bug.
  ok(
    `route answers non-2xx when processing failed (got ${res.statusCode})`,
    res.statusCode >= 500 && res.statusCode !== 200,
  );

  // ── 5) REPLAY: the last resort once the gateway has given up ──────────────
  // Gateways cap their own retries (Stripe ~3 days). Past that an `error` row is
  // terminal unless a human can re-run it.
  const [errored] = await systemDb
    .select()
    .from(providerEvents)
    .where(
      and(eq(providerEvents.providerKey, "tmtest"), eq(providerEvents.providerEventId, failingId)),
    )
    .limit(1);
  ok(
    "the errored row stored its normalized event (what replay consumes)",
    errored?.normalized != null,
  );

  // Still failing — the bad currency is baked into the stored event, so the replay
  // legitimately errors again. What matters is that it RAN and stayed one row.
  const again = await replayGatewayWebhook(orgId, biz.id, errored!.id);
  ok(
    `replay of an errored event runs (ok=${again.ok}, outcome=${again.ok ? again.outcome : "—"})`,
    again.ok && again.outcome === "error",
  );
  const rows = await systemDb
    .select()
    .from(providerEvents)
    .where(
      and(eq(providerEvents.providerKey, "tmtest"), eq(providerEvents.providerEventId, failingId)),
    );
  ok("replay updates the existing row, never creates a second", rows.length === 1);

  // An IGNORED event MUST be replayable (2026-09-05). `ignored` is two verdicts wearing
  // one name — "redundant, not ours" and "our code did not understand this yet" — and the
  // second is a defect whose events a fixed handler has to be able to re-run. Four real
  // Stripe charge.succeeded (₹35,472.22 captured) were unrecoverable because this was
  // refused: replay said no, and the gateway's own redelivery hit the same dedup.
  const [ignoredRow] = await systemDb
    .select()
    .from(providerEvents)
    .where(and(eq(providerEvents.providerKey, "tmtest"), eq(providerEvents.providerEventId, okId)))
    .limit(1);
  const rerun = await replayGatewayWebhook(orgId, biz.id, ignoredRow!.id);
  ok(
    `replay of an ignored event RUNS (ok=${rerun.ok}, outcome=${rerun.ok ? rerun.outcome : "—"})`,
    rerun.ok && rerun.outcome === "ignored",
  );
  const ignoredRows = await systemDb
    .select()
    .from(providerEvents)
    .where(and(eq(providerEvents.providerKey, "tmtest"), eq(providerEvents.providerEventId, okId)));
  ok(
    "replaying an ignored event updates the row, never creates a second",
    ignoredRows.length === 1,
  );

  // …but a PROCESSED event must never re-run: that row already booked money, and
  // re-running its handlers is exactly how you double-post.
  await systemDb
    .update(providerEvents)
    .set({ outcome: "processed" })
    .where(eq(providerEvents.id, ignoredRow!.id));
  const refused = await replayGatewayWebhook(orgId, biz.id, ignoredRow!.id);
  ok("replaying a PROCESSED event is REFUSED", !refused.ok && refused.reason === "not_replayable");
  await systemDb
    .update(providerEvents)
    .set({ outcome: "ignored" })
    .where(eq(providerEvents.id, ignoredRow!.id));

  // A row from before the normalized column cannot be replayed, and says so rather
  // than guessing at an event it never recorded.
  await systemDb
    .update(providerEvents)
    .set({ normalized: null })
    .where(eq(providerEvents.id, errored!.id));
  const legacy = await replayGatewayWebhook(orgId, biz.id, errored!.id);
  ok(
    "a pre-migration row is refused with a reason, not guessed at",
    !legacy.ok && legacy.reason === "no_normalized",
  );

  const missing = await replayGatewayWebhook(orgId, biz.id, randomUUID());
  ok("replaying an unknown id is not_found", !missing.ok && missing.reason === "not_found");

  await ourRetry(orgId, biz.id, acct!);
}

/**
 * Phase 6a: an errored synchronous delivery is retried by OUR job, not only by the gateway.
 *
 * The fault is a trigger on `disputes` keyed to this run's dispute ids: `raise` fails the
 * handler, `sleep` slows it so a redelivery lands mid-run, no row lets it succeed.
 */
async function ourRetry(
  orgId: string,
  businessId: string,
  acct: typeof gatewayAccounts.$inferSelect,
) {
  const T = `verify_6a_fault_${RUN}`;
  await systemDb.execute(sql.raw(`create table ${T} (dispute_id text primary key, mode text)`));
  await systemDb.execute(
    sql.raw(`create function ${T}() returns trigger language plpgsql security definer as $f$
      declare m text;
      begin
        select mode into m from ${T} where dispute_id = new.provider_dispute_id;
        if m = 'raise' then raise exception 'injected fault'; end if;
        if m = 'sleep' then perform pg_sleep(1.5); end if;
        return new;
      end $f$`),
  );
  await systemDb.execute(
    sql.raw(`create trigger ${T} before insert on disputes for each row execute function ${T}()`),
  );
  const fault = async (disputeId: string, mode: "raise" | "sleep" | null) => {
    await systemDb.execute(sql`delete from ${sql.raw(T)} where dispute_id = ${disputeId}`);
    if (mode) await systemDb.execute(sql`insert into ${sql.raw(T)} values (${disputeId}, ${mode})`);
  };
  try {
    await ourRetryChecks(orgId, businessId, acct, fault);
  } finally {
    await systemDb.execute(sql.raw(`drop trigger if exists ${T} on disputes`));
    await systemDb.execute(sql.raw(`drop function if exists ${T}()`));
    await systemDb.execute(sql.raw(`drop table if exists ${T}`));
    await systemDb.execute(
      sql`delete from graphile_worker._private_jobs where key like ${`gwhook:tmtest:${businessId}:%`}`,
    );
  }
}

async function ourRetryChecks(
  orgId: string,
  businessId: string,
  acct: typeof gatewayAccounts.$inferSelect,
  fault: (disputeId: string, mode: "raise" | "sleep" | null) => Promise<void>,
) {
  const url = `/v1/gateway_webhooks/tmtest?id=${acct.publicId}`;
  const disputeEvent = (tag: string) => ({
    id: `evt_6a_${tag}_${RUN}`,
    type: "dispute.created",
    data: {
      provider_dispute_id: `dp_6a_${tag}_${RUN}`,
      provider_charge_id: `ch_6a_${tag}_${RUN}`,
      amount_minor: 1000,
      currency: "USD",
    },
  });
  const post = (body: object) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        host: "verify.example.com",
        "x-tmtest-signature": signTmtest(body),
      },
      payload: JSON.stringify(body),
    });
  const row = async (eventId: string) =>
    (
      await systemDb
        .select()
        .from(providerEvents)
        .where(
          and(
            eq(providerEvents.providerKey, "tmtest"),
            eq(providerEvents.businessId, businessId),
            eq(providerEvents.providerEventId, eventId),
          ),
        )
    )[0];
  const disputeRows = async (disputeId: string) =>
    (
      await systemDb
        .select({ id: disputes.id })
        .from(disputes)
        .where(and(eq(disputes.businessId, businessId), eq(disputes.providerDisputeId, disputeId)))
    ).length;
  /** Every queued job that names this event, oldest first. */
  const jobsFor = async (eventId: string) =>
    (await systemDb.execute(sql`
      select j.key, j.attempts, j.max_attempts, j.payload::jsonb as payload
        from graphile_worker._private_jobs j
        join graphile_worker._private_tasks t on t.id = j.task_id
       where t.identifier = ${PROCESS_GATEWAY_WEBHOOK_TASK}
         and (j.payload::jsonb)->'providerEventIds' ? ${eventId}
       order by j.id`)) as unknown as Array<{
      key: string;
      attempts: number;
      max_attempts: number;
      payload: StoredDeliveryJob;
    }>;
  const age = (eventId: string, minutes: number) =>
    systemDb
      .update(providerEvents)
      .set({
        receivedAt: new Date(Date.now() - minutes * 60_000),
        processedAt: new Date(Date.now() - minutes * 60_000),
      })
      .where(
        and(
          eq(providerEvents.providerKey, "tmtest"),
          eq(providerEvents.businessId, businessId),
          eq(providerEvents.providerEventId, eventId),
        ),
      );

  // ── (a) one failed sync delivery is booked once by OUR job, no redelivery ──
  const a = disputeEvent("a");
  await fault(a.data.provider_dispute_id, "raise");
  const aRes = await post(a);
  ok(`(a) the failed delivery still answers 502 (got ${aRes.statusCode})`, aRes.statusCode === 502);
  const [aJob] = await jobsFor(a.id);
  ok(
    `(a) …and queues our retry job (key ${aJob?.key.slice(0, 20)}…, max ${aJob?.max_attempts})`,
    aJob?.key ===
      storedDeliveryJobKey({ gatewayKey: "tmtest", businessId, providerEventIds: [a.id] }) &&
      aJob.max_attempts === PROCESS_MAX_ATTEMPTS &&
      aJob.payload.gatewayAccountId === acct.id,
  );
  await fault(a.data.provider_dispute_id, null);
  const aRun = await processStoredGatewayWebhook(aJob!.payload, { attempts: 1, maxAttempts: 25 });
  const aAfter = await row(a.id);
  ok(
    `(a) the job books it (results ${aRun.join(",")}, outcome ${aAfter?.outcome})`,
    aRun.length === 1 &&
      aRun[0] !== "error" &&
      aRun[0] !== "duplicate" &&
      aAfter?.outcome !== "error",
  );
  ok("(a) …exactly once", (await disputeRows(a.data.provider_dispute_id)) === 1);
  const aAgain = await processStoredGatewayWebhook(aJob!.payload, { attempts: 2, maxAttempts: 25 });
  ok(
    `(a) a second run of the job applies nothing (got ${aAgain.join(",") || "none"})`,
    aAgain.length === 0,
  );

  // ── (b) a redelivery racing the job: one of them books ─────────────────────
  const b = disputeEvent("b");
  await fault(b.data.provider_dispute_id, "raise");
  await post(b);
  const [bJob] = await jobsFor(b.id);
  await fault(b.data.provider_dispute_id, "sleep");
  const jobRun = processStoredGatewayWebhook(bJob!.payload, { attempts: 1, maxAttempts: 25 });
  await new Promise((r) => setTimeout(r, 300));
  const redelivery = post(b);
  const [bResults, bRes] = await Promise.all([jobRun, redelivery]);
  const routeResults = (bRes.json() as { results?: string[] }).results ?? [];
  const applied = [...bResults, ...routeResults].filter((r) => r !== "duplicate");
  ok(
    `(b) job + concurrent redelivery apply the event once (job ${bResults.join(",")}, route ${bRes.statusCode} ${routeResults.join(",")})`,
    applied.length === 1 && applied[0] !== "error" && bRes.statusCode === 200,
  );
  ok("(b) …one dispute row", (await disputeRows(b.data.provider_dispute_id)) === 1);
  await fault(b.data.provider_dispute_id, null);

  // ── (c) the last failed try leaves a durable record ───────────────────────
  const c = disputeEvent("c");
  await fault(c.data.provider_dispute_id, "raise");
  await post(c);
  const [cJob] = await jobsFor(c.id);
  const threw = async (attempts: number) =>
    processStoredGatewayWebhook(cJob!.payload, { attempts, maxAttempts: 25 }).then(
      () => false,
      () => true,
    );
  ok("(c) a failing try throws, so the queue retries", await threw(24));
  ok(
    "(c) …and a try before the last leaves no exhausted note",
    !(await row(c.id))?.error?.includes(RETRIES_EXHAUSTED_NOTE),
  );
  ok("(c) the last try throws too", await threw(25));
  const cRow = await row(c.id);
  ok(
    `(c) …and marks the row (${cRow?.error?.slice(-90)})`,
    cRow?.outcome === "error" &&
      !!cRow.error?.includes(`${RETRIES_EXHAUSTED_NOTE} after 25 attempts`),
  );
  // What graphile leaves after the last throw: the job stays, exhausted.
  await systemDb.execute(
    sql`update graphile_worker._private_jobs set attempts = max_attempts where key = ${cJob!.key}`,
  );

  // ── (d) the clock pass re-queues an orphan and leaves the rest alone ───────
  // Orphan: errored with no job (the shape of a row from before this change).
  const d = disputeEvent("d");
  await fault(d.data.provider_dispute_id, "raise");
  await post(d);
  await systemDb.execute(
    sql`delete from graphile_worker._private_jobs where key = ${storedDeliveryJobKey({ gatewayKey: "tmtest", businessId, providerEventIds: [d.id] })}`,
  );
  // Exhausted job, no note: the job alone keeps the pass away.
  const e = disputeEvent("e");
  await fault(e.data.provider_dispute_id, "raise");
  await post(e);
  await systemDb.execute(
    sql`update graphile_worker._private_jobs set attempts = max_attempts where key = ${storedDeliveryJobKey({ gatewayKey: "tmtest", businessId, providerEventIds: [e.id] })}`,
  );
  // Live job: errored, but its job still retries.
  const l = disputeEvent("l");
  await fault(l.data.provider_dispute_id, "raise");
  await post(l);
  // A second copy while that job is live queues nothing new.
  await post(l);
  ok(
    "(d) a redelivery while a job is live queues no second job",
    (await jobsFor(l.id)).length === 1,
  );
  // Fresh orphan: inside the grace window, still the delivery's own to queue.
  const f = disputeEvent("f");
  await fault(f.data.provider_dispute_id, "raise");
  await post(f);
  await systemDb.execute(
    sql`delete from graphile_worker._private_jobs where key = ${storedDeliveryJobKey({ gatewayKey: "tmtest", businessId, providerEventIds: [f.id] })}`,
  );
  for (const id of [a.id, c.id, d.id, e.id, l.id]) await age(id, 10);
  const before = {
    a: (await jobsFor(a.id)).length,
    c: (await jobsFor(c.id)).length,
    e: (await jobsFor(e.id)).length,
    l: (await jobsFor(l.id)).length,
  };
  const pass = await runWithClockScope({ onlyBusinessId: businessId }, () =>
    requeueStrandedGatewayWebhooks(new Date()),
  );
  const dJobs = await jobsFor(d.id);
  ok(
    `(d) the pass queues the orphan (examined ${pass.examined}, queued ${pass.queued})`,
    pass.queued === 1 &&
      pass.errors.length === 0 &&
      dJobs.length === 1 &&
      dJobs[0]!.payload.gatewayAccountId === acct.id,
  );
  ok(
    "(d) …and leaves settled, exhausted and live-job rows alone",
    (await jobsFor(a.id)).length === before.a &&
      (await jobsFor(c.id)).length === before.c &&
      (await jobsFor(e.id)).length === before.e &&
      (await jobsFor(l.id)).length === before.l,
  );
  ok("(d) …and a fresh error inside the grace window", (await jobsFor(f.id)).length === 0);
  const again = await runWithClockScope({ onlyBusinessId: businessId }, () =>
    requeueStrandedGatewayWebhooks(new Date()),
  );
  ok(`(d) a second pass queues nothing (queued ${again.queued})`, again.queued === 0);
  await fault(d.data.provider_dispute_id, null);
  const dRun = await processStoredGatewayWebhook(dJobs[0]!.payload, {
    attempts: 1,
    maxAttempts: 25,
  });
  ok(
    `(d) the re-queued job books the orphan once (${dRun.join(",")})`,
    dRun.length === 1 &&
      dRun[0] !== "error" &&
      (await row(d.id))?.outcome !== "error" &&
      (await disputeRows(d.data.provider_dispute_id)) === 1,
  );
  void orgId;
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ WEBHOOK RETRY: PASS" : "\n❌ WEBHOOK RETRY: FAIL");
await app.close();
await closeDb();
process.exit(pass ? 0 : 1);
