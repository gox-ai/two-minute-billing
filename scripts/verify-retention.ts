/**
 * verify:retention — the nightly retention sweep (D17) removes only rows past their period,
 * keeps every guarded row, and follows each organization's own mode and periods.
 *
 * Every sweep here is scoped to a fixture organization (`onlyOrganizationId`), so the suite
 * never deletes anything else in the database. Platform data is checked through its count
 * queries, which select exactly what `on` would delete.
 */
import { eq, inArray } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { publicId, uuidv7 } from "@/platform/ids";
import { resendEmail } from "@/modules/emails/service";
import { platformDatasets, retentionDefaultsRow, runRetentionSweep } from "@/modules/ops/retention";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import {
  apiRequestLogs,
  businesses,
  clockTicks,
  emailMessages,
  events,
  gatewayRequestLogs,
  idempotencyKeys,
  opsInvariantResults,
  organizationRetention,
  organizations,
  providerEvents,
  retentionDefaults,
  webhookDeliveries,
} from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, cond ? "" : JSON.stringify(detail ?? ""));
}

const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const tag = `ret_${Date.now()}`;

// Recreated when missing; the database's own row is put back at the end.
const [original] = await systemDb.select().from(retentionDefaults);
await systemDb.delete(retentionDefaults);
const defaults = await retentionDefaultsRow();
ok("a missing defaults row is recreated", !!defaults);
ok(
  "the seeded defaults are the decided periods, in dry run",
  defaults?.mode === "dry_run" &&
    defaults.eventsDays === 90 &&
    defaults.webhookDeliveriesDays === 30 &&
    defaults.gatewayLogsDays === 90 &&
    defaults.emailBodyDays === 90 &&
    defaults.idempotencyHours === 24 &&
    defaults.clockTicksDays === 30 &&
    defaults.apiLogWritesDays === 90 &&
    defaults.apiLogReadsDays === 30 &&
    defaults.invariantResultsDays === 30,
  defaults,
);

/** One fixture organization + business holding a row of every kind on each side of its period. */
async function fixture(name: string) {
  const [org] = await systemDb
    .insert(organizations)
    .values({ publicId: publicId("org"), name: `retention verify ${name}` })
    .returning();
  const [biz] = await systemDb
    .insert(businesses)
    .values({
      organizationId: org!.id,
      publicId: publicId("biz"),
      name: "b",
      defaultCurrency: "USD",
      timezone: "UTC",
    })
    .returning();
  const o = org!.id;
  const b = biz!.id;
  const ev = async (createdAt: Date) => {
    const [e] = await systemDb
      .insert(events)
      .values({
        organizationId: o,
        businessId: b,
        publicId: publicId("evt"),
        type: "customer_created",
        data: {},
        createdAt,
      })
      .returning({ id: events.id });
    return e!.id;
  };
  const delivery = async (eventId: string, status: string, createdAt: Date) => {
    const [d] = await systemDb
      .insert(webhookDeliveries)
      .values({
        organizationId: o,
        eventId,
        businessId: b,
        endpointId: org!.id,
        status,
        createdAt,
      })
      .returning({ id: webhookDeliveries.id });
    return d!.id;
  };
  const ids = {
    org: o,
    biz: b,
    eventOld: await ev(ago(100)),
    eventRecent: await ev(ago(10)),
    eventPending: await ev(ago(100)),
    eventKeptDelivery: await ev(ago(100)),
    eventOldDelivery: await ev(ago(100)),
    holder: await ev(ago(5)),
  } as Record<string, string>;
  ids.deliveryPending = await delivery(ids.eventPending!, "pending", ago(100));
  ids.deliveryKeptByPeriod = await delivery(ids.eventKeptDelivery!, "delivered", ago(10));
  ids.deliveryOld = await delivery(ids.eventOldDelivery!, "delivered", ago(40));
  // On a recent event, so only the delivery period decides them.
  ids.deliveryDelivered40 = await delivery(ids.holder!, "delivered", ago(40));
  ids.deliveryFailed40 = await delivery(ids.holder!, "failed", ago(40));
  ids.deliveryPending40 = await delivery(ids.holder!, "pending", ago(40));
  ids.deliveryDelivered10 = await delivery(ids.holder!, "delivered", ago(10));

  const gw = async (createdAt: Date) => {
    const [g] = await systemDb
      .insert(gatewayRequestLogs)
      .values({ businessId: b, gatewayKey: "tmtest", method: "POST", url: "/x", createdAt })
      .returning({ id: gatewayRequestLogs.id });
    return g!.id;
  };
  ids.gwOld = await gw(ago(100));
  ids.gwRecent = await gw(ago(10));
  const hook = async (receivedAt: Date) => {
    const [p] = await systemDb
      .insert(providerEvents)
      .values({
        providerKey: "tmtest",
        providerEventId: `${tag}_${Math.random()}`,
        type: "payment.captured",
        businessId: b,
        receivedAt,
        payload: { id: "evt_body" },
        headers: { "x-sig": "***" },
        normalized: { type: "payment.captured" },
        outcome: "processed",
        error: "e",
      })
      .returning({ id: providerEvents.id });
    return p!.id;
  };
  ids.hookOld = await hook(ago(100));
  ids.hookRecent = await hook(ago(10));

  const mail = async (status: string, createdAt: Date) => {
    const [m] = await systemDb
      .insert(emailMessages)
      .values({
        publicId: publicId("em"),
        organizationId: o,
        businessId: b,
        type: "invoice_issued",
        toAddress: "buyer@example.com",
        subject: "s",
        bodyHtml: "<p>hello</p>",
        bodyText: "hello",
        status,
        createdAt,
      })
      .returning({ id: emailMessages.id, publicId: emailMessages.publicId });
    return m!;
  };
  const sentOld = await mail("sent", ago(100));
  ids.mailSentOld = sentOld.id;
  ids.mailSentOldPublic = sentOld.publicId;
  ids.mailPendingOld = (await mail("pending", ago(100))).id;
  ids.mailSentRecent = (await mail("sent", ago(10))).id;

  const key = async (status: string, createdAt: Date) => {
    const [k] = await systemDb
      .insert(idempotencyKeys)
      .values({
        organizationId: o,
        key: `${tag}_${Math.random()}`,
        requestFingerprint: "f",
        status,
        createdAt,
      })
      .returning({ id: idempotencyKeys.id });
    return k!.id;
  };
  ids.keyCompletedOld = await key("completed", hoursAgo(30));
  ids.keyFailedOld = await key("failed", hoursAgo(30));
  ids.keyInProgressOld = await key("in_progress", hoursAgo(30));
  ids.keyCompletedRecent = await key("completed", hoursAgo(1));

  // API request log: writes 90 days, reads 30 days.
  const reqLog = async (kind: "read" | "write", createdAt: Date) => {
    const id = uuidv7();
    await systemDb.insert(apiRequestLogs).values({
      id,
      organizationId: o,
      source: "api",
      method: kind === "write" ? "POST" : "GET",
      path: "/v1/x",
      kind,
      status: 200,
      createdAt,
    });
    return id;
  };
  ids.writeOld = await reqLog("write", ago(100));
  ids.writeRecent = await reqLog("write", ago(40));
  ids.readOld = await reqLog("read", ago(40));
  ids.readRecent = await reqLog("read", ago(10));
  return ids;
}

const logged = async (id: string) =>
  (
    await systemDb
      .select({ id: apiRequestLogs.id })
      .from(apiRequestLogs)
      .where(eq(apiRequestLogs.id, id))
  ).length === 1;

const exists = async (table: typeof events | typeof webhookDeliveries, id: string) =>
  (await systemDb.select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1;
const has = async (
  table: typeof gatewayRequestLogs | typeof providerEvents | typeof idempotencyKeys,
  id: string,
) => (await systemDb.select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1;
const mailRow = async (id: string) =>
  (await systemDb.select().from(emailMessages).where(eq(emailMessages.id, id)))[0]!;
const setOwn = (org: string, own: Partial<typeof organizationRetention.$inferInsert>) =>
  systemDb
    .insert(organizationRetention)
    .values({ organizationId: org, ...own })
    .onConflictDoUpdate({ target: organizationRetention.organizationId, set: own });
const lastRun = async (org: string) =>
  (
    await systemDb
      .select()
      .from(organizationRetention)
      .where(eq(organizationRetention.organizationId, org))
  )[0];

const fixtures: Record<string, string>[] = [];
try {
  // ── 1. on: every dataset, a batch of 2 so each loops ────────────────────────────────
  const a = await fixture("on");
  fixtures.push(a);
  const bystander = await fixture("bystander");
  fixtures.push(bystander);
  await setOwn(a.org!, { mode: "on" });
  const r = await runRetentionSweep(NOW, { onlyOrganizationId: a.org!, batch: 2 });
  ok("on: the organization is swept in mode on", r.organizations.on === 1 && r.complete, r);
  ok("request log: a write past 90 days is deleted", !(await logged(a.writeOld!)));
  ok("request log: a write inside 90 days stays", await logged(a.writeRecent!));
  ok("request log: a read past 30 days is deleted", !(await logged(a.readOld!)));
  ok("request log: a read inside 30 days stays", await logged(a.readRecent!));
  ok(
    "request log: another organization's rows stay",
    (await logged(bystander.writeOld!)) && (await logged(bystander.readOld!)),
  );
  ok(
    "request log counts are recorded",
    (await lastRun(a.org!))?.lastRun?.api_log_writes === 1 &&
      (await lastRun(a.org!))?.lastRun?.api_log_reads === 1,
    (await lastRun(a.org!))?.lastRun,
  );

  ok("events past 90 days are deleted", !(await exists(events, a.eventOld!)));
  ok("events inside 90 days stay", await exists(events, a.eventRecent!));
  ok("an event with a pending delivery stays", await exists(events, a.eventPending!));
  ok(
    "an event whose delivery the delivery period keeps stays",
    await exists(events, a.eventKeptDelivery!),
  );
  ok(
    "an event whose deliveries are all past their period is deleted, with them",
    !(await exists(events, a.eventOldDelivery!)) &&
      !(await exists(webhookDeliveries, a.deliveryOld!)),
  );
  ok(
    "delivered and failed deliveries past 30 days are deleted",
    !(await exists(webhookDeliveries, a.deliveryDelivered40!)) &&
      !(await exists(webhookDeliveries, a.deliveryFailed40!)),
  );
  ok(
    "a pending delivery stays, however old",
    (await exists(webhookDeliveries, a.deliveryPending40!)) &&
      (await exists(webhookDeliveries, a.deliveryPending!)),
  );
  ok("a delivery inside 30 days stays", await exists(webhookDeliveries, a.deliveryDelivered10!));
  ok(
    "gateway calls past 90 days are deleted; recent ones stay",
    !(await has(gatewayRequestLogs, a.gwOld!)) && (await has(gatewayRequestLogs, a.gwRecent!)),
  );
  const hookRow = async (id: string) =>
    (await systemDb.select().from(providerEvents).where(eq(providerEvents.id, id)))[0]!;
  const stripped = await hookRow(a.hookOld!);
  ok(
    "a gateway webhook past 90 days loses its contents and keeps its dedup key",
    stripped.payload === null &&
      stripped.headers === null &&
      stripped.normalized === null &&
      stripped.error === null &&
      stripped.type === "payment.captured" &&
      stripped.outcome === "processed" &&
      stripped.businessId === a.biz,
    stripped,
  );
  ok("a recent gateway webhook keeps its contents", (await hookRow(a.hookRecent!)).payload != null);
  const redelivered = await handleProviderEvent(
    "tmtest",
    {
      providerEventId: stripped.providerEventId,
      type: "charge.succeeded",
      occurredAt: new Date(),
      raw: {},
    },
    { businessId: a.biz! },
  );
  ok(
    "a redelivery of a stripped event is still a duplicate",
    redelivered === "duplicate",
    redelivered,
  );
  const cleared = await mailRow(a.mailSentOld!);
  ok(
    "a sent email past 90 days keeps its record and loses its body",
    cleared.bodyHtml === "" &&
      cleared.bodyText === "" &&
      cleared.bodyRemovedAt != null &&
      cleared.toAddress === "buyer@example.com" &&
      cleared.subject === "s",
    cleared,
  );
  ok(
    "a pending email and a recent one keep their bodies",
    (await mailRow(a.mailPendingOld!)).bodyHtml !== "" &&
      (await mailRow(a.mailSentRecent!)).bodyHtml !== "",
  );
  ok(
    "finished idempotency keys past 24 hours are deleted",
    !(await has(idempotencyKeys, a.keyCompletedOld!)) &&
      !(await has(idempotencyKeys, a.keyFailedOld!)),
  );
  ok(
    "an in-progress key and a recent finished one stay",
    (await has(idempotencyKeys, a.keyInProgressOld!)) &&
      (await has(idempotencyKeys, a.keyCompletedRecent!)),
  );
  const runA = await lastRun(a.org!);
  ok(
    "the run is recorded on the organization with its counts",
    runA?.lastRunMode === "on" &&
      runA.lastRun?.events === 2 &&
      runA.lastRun?.webhook_deliveries === 3 &&
      runA.lastRun?.email_bodies === 1 &&
      runA.lastRun?.idempotency_keys === 2 &&
      runA.lastRun?.gateway_calls === 1 &&
      runA.lastRun?.gateway_webhooks === 1,
    runA?.lastRun,
  );
  const again = await runRetentionSweep(NOW, { onlyOrganizationId: a.org! });
  ok(
    "a second run finds nothing more",
    Object.values(again.removed).every((n) => n === 0),
    again.removed,
  );
  ok(
    "an email with its body deleted cannot be resent",
    (await resendEmail(a.org!, a.biz!, a.mailSentOldPublic!)) === "body_removed",
  );

  // ── 2. dry run counts the same rows and deletes none ────────────────────────────────
  const d = await fixture("dry");
  fixtures.push(d);
  await setOwn(d.org!, { mode: "dry_run" });
  const dr = await runRetentionSweep(NOW, { onlyOrganizationId: d.org! });
  ok(
    "dry run counts what on deletes",
    dr.wouldRemove.events === 2 &&
      dr.wouldRemove.webhook_deliveries === 3 &&
      dr.wouldRemove.email_bodies === 1 &&
      dr.wouldRemove.idempotency_keys === 2 &&
      dr.wouldRemove.gateway_webhooks === 1 &&
      Object.keys(dr.removed).every((k) => k.startsWith("api_log_")),
    dr,
  );
  ok(
    "dry run still deletes the request log past its periods",
    !(await logged(d.writeOld!)) && !(await logged(d.readOld!)) && (await logged(d.writeRecent!)),
  );
  ok(
    "dry run deletes nothing",
    (await exists(events, d.eventOld!)) &&
      (await has(idempotencyKeys, d.keyCompletedOld!)) &&
      (await mailRow(d.mailSentOld!)).bodyHtml !== "" &&
      (await hookRow(d.hookOld!)).payload != null,
  );
  ok("dry run is recorded as a dry run", (await lastRun(d.org!))?.lastRunMode === "dry_run");

  // ── 3. off touches nothing and records nothing ──────────────────────────────────────
  const f = await fixture("off");
  fixtures.push(f);
  await setOwn(f.org!, { mode: "off" });
  const fr = await runRetentionSweep(NOW, { onlyOrganizationId: f.org! });
  ok("off: the organization is skipped", fr.organizations.off === 1, fr);
  ok(
    "off deletes nothing",
    (await exists(events, f.eventOld!)) && (await has(gatewayRequestLogs, f.gwOld!)),
  );
  ok(
    "off still deletes the request log past its periods",
    !(await logged(f.writeOld!)) && !(await logged(f.readOld!)) && (await logged(f.readRecent!)),
  );
  ok(
    "off records the request log run only",
    Object.keys((await lastRun(f.org!))?.lastRun ?? {}).every((k) => k.startsWith("api_log_")) &&
      (await lastRun(f.org!))?.lastRunMode === "off",
    await lastRun(f.org!),
  );

  // ── 4. an organization's own periods win over the defaults ──────────────────────────
  const p = await fixture("periods");
  fixtures.push(p);
  await setOwn(p.org!, {
    mode: "on",
    eventsDays: 0,
    emailBodyDays: 200,
    idempotencyHours: 48,
    apiLogWritesDays: 200,
    apiLogReadsDays: 0,
  });
  await runRetentionSweep(NOW, { onlyOrganizationId: p.org! });
  ok("api_log_writes_days 200 keeps a 100-day write", await logged(p.writeOld!));
  ok("api_log_reads_days 0 keeps reads forever", await logged(p.readOld!));
  ok("events_days 0 keeps events forever", await exists(events, p.eventOld!));
  ok("email_body_days 200 keeps a 100-day body", (await mailRow(p.mailSentOld!)).bodyHtml !== "");
  ok("idempotency_hours 48 keeps a 30-hour key", await has(idempotencyKeys, p.keyCompletedOld!));
  ok(
    "an unset period still follows the default",
    !(await has(gatewayRequestLogs, p.gwOld!)) &&
      !(await exists(webhookDeliveries, p.deliveryDelivered40!)),
  );

  // ── 5. platform data: the count queries select exactly what on would delete ─────────
  const countOf = async (key: string) => {
    const ds = platformDatasets(defaults!, NOW).find((x) => x.key === key)!;
    const [row] = (await systemDb.execute(ds.count)) as unknown as Array<{ n: number }>;
    return row?.n ?? 0;
  };
  const ticksBefore = await countOf("clock_ticks");
  const tickIds = (
    await systemDb
      .insert(clockTicks)
      .values([{ startedAt: ago(40) }, { startedAt: ago(5) }])
      .returning({ id: clockTicks.id })
  ).map((t) => t.id);
  ok(
    "a clock tick past 30 days is selected, a recent one is not",
    (await countOf("clock_ticks")) === ticksBefore + 1,
  );
  const checkKey = `${tag}_check`;
  const resultsBefore = await countOf("invariant_results");
  const resultIds = (
    await systemDb
      .insert(opsInvariantResults)
      .values(
        [40, 50, 60].map((days) => ({
          checkKey,
          severity: "warn",
          violations: 0,
          ranAt: ago(days),
        })),
      )
      .returning({ id: opsInvariantResults.id })
  ).map((t) => t.id);
  ok(
    "old invariant results are selected, except the check's latest",
    (await countOf("invariant_results")) === resultsBefore + 2,
  );
  await systemDb.delete(clockTicks).where(inArray(clockTicks.id, tickIds));
  await systemDb.delete(opsInvariantResults).where(inArray(opsInvariantResults.id, resultIds));
} finally {
  for (const f of fixtures) {
    const o = f.org!;
    await systemDb.delete(webhookDeliveries).where(eq(webhookDeliveries.organizationId, o));
    await systemDb.delete(emailMessages).where(eq(emailMessages.organizationId, o));
    await systemDb.delete(events).where(eq(events.organizationId, o));
    await systemDb.delete(idempotencyKeys).where(eq(idempotencyKeys.organizationId, o));
    await systemDb.delete(apiRequestLogs).where(eq(apiRequestLogs.organizationId, o));
    await systemDb.delete(gatewayRequestLogs).where(eq(gatewayRequestLogs.businessId, f.biz!));
    await systemDb.delete(providerEvents).where(eq(providerEvents.businessId, f.biz!));
    await systemDb.delete(businesses).where(eq(businesses.id, f.biz!));
    await systemDb.delete(organizations).where(eq(organizations.id, o));
  }
  if (original) await systemDb.update(retentionDefaults).set(original);
}

console.log(
  `\n${fail === 0 ? "✅" : "❌"} RETENTION: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
