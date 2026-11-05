/**
 * HubSpot sync, phase 1: connect, the outbox sink, the push engine, and disconnect — against a
 * local stand-in for HubSpot. No request leaves this process.
 *
 * What regresses without this:
 *  1. the app's required scopes drift from what we request — HubSpot refuses every install.
 *  2. tokens land in the row in plaintext.
 *  3. an event on a business without HubSpot queues work, or a burst on one customer queues many.
 *  4. a push re-sends an unchanged record, or PATCHes a contact HubSpot deleted instead of re-matching.
 *  5. an expiring token is not refreshed, a 429 is not waited out, a 5xx is dropped, a 400 retried.
 *  6. a revoked grant burns queue attempts instead of flagging the connection for reconnect.
 *  7. disconnect leaves tokens behind or keeps queuing.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-sync
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Pinned, not inherited from .env: config is read at import, and a real secret must never be sent to the stand-in.
process.env.HUBSPOT_CLIENT_ID = "verify-client-id";
process.env.HUBSPOT_CLIENT_SECRET = "verify-client-secret";
process.env.HUBSPOT_REDIRECT_URI = "http://localhost:4100/integrations/hubspot/callback";

const { eq, inArray, sql } = await import("drizzle-orm");
const { closeDb, withTenant } = await import("@/platform/db");
const { createOrganization, createBusiness } = await import("@/modules/tenancy/service");
const { createCustomer, updateCustomer } = await import("@/modules/customers/service");
await import("@/modules/integrations/sink");
const { REQUIRED_SCOPES, authorizeUrlBase } = await import("@/modules/hubspot/oauth");
const { connectHubSpot, disconnectHubSpot, getConnection, updateConnection, startFirstSync } =
  await import("@/modules/hubspot/connections");
const { runSync, connectionsWithDueWork, autosyncConnections } =
  await import("@/modules/hubspot/sync/engine");
const { beginShutdown } = await import("@/platform/shutdown");
const { hubspotConnections, hubspotLinks, hubspotSyncItems, hubspotSyncQueue, hubspotSyncRuns } =
  await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);

type Hit = { method: string; path: string; body: Record<string, unknown>; auth?: string };
const hits: Hit[] = [];
/** Scripted answers, consumed in order per "METHOD path-prefix"; default is success. */
const script: Array<{
  match: string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}> = [];
let tokenSeq = 0;
let nextContactId = 1000;
const contactsByEmail = new Map<string, string>();
const deletedContacts = new Set<string>();

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const method = req.method ?? "GET";
    const path = req.url ?? "";
    let body: Record<string, unknown> = {};
    try {
      body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    } catch {}
    hits.push({ method, path, body, auth: req.headers.authorization });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload ?? {}));
    };

    const i = script.findIndex((s) => `${method} ${path}`.startsWith(s.match));
    if (i >= 0) {
      const s = script.splice(i, 1)[0]!;
      return send(s.status, s.body ?? { message: `scripted ${s.status}` }, s.headers);
    }

    if (method === "POST" && path === "/oauth/v1/token") {
      tokenSeq += 1;
      return send(200, {
        access_token: `at-${RUN}-${tokenSeq}`,
        refresh_token: `rt-${RUN}`,
        expires_in: 1800,
      });
    }
    if (method === "GET" && path.startsWith("/oauth/v1/access-tokens/")) {
      return send(200, {
        hub_id: 424242,
        hub_domain: "verify.hubspot.test",
        user: "ops@verify.test",
        scopes: [...REQUIRED_SCOPES],
      });
    }
    if (method === "DELETE" && path.startsWith("/oauth/v1/refresh-tokens/")) return send(204, null);
    if (method === "POST" && path === "/crm/v3/objects/contacts/search") {
      const value = (body.filterGroups as Array<{ filters: Array<{ value: string }> }>)[0]!
        .filters[0]!.value;
      const id = contactsByEmail.get(value.toLowerCase());
      return send(200, { total: id ? 1 : 0, results: id ? [{ id, properties: {} }] : [] });
    }
    if (method === "POST" && path === "/crm/v3/objects/contacts") {
      const email = (body.properties as Record<string, string>).email!;
      const id = String(nextContactId++);
      contactsByEmail.set(email, id);
      return send(201, { id });
    }
    const patch = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(path);
    if (method === "PATCH" && patch) {
      if (deletedContacts.has(patch[1]!)) return send(404, { message: "resource not found" });
      return send(200, { id: patch[1] });
    }
    send(404, { message: `unexpected ${method} ${path}` });
  });
});

const count = async (orgId: string, table: typeof hubspotSyncQueue | typeof hubspotLinks) =>
  withTenant(orgId, async (tx) => {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(table);
    return r?.n ?? 0;
  });

async function main() {
  // 1. The scopes we request are exactly the app's required scopes.
  const app = JSON.parse(readFileSync("hubspot-app/src/app/app-hsmeta.json", "utf8"));
  const appScopes: string[] = app.config.auth.requiredScopes;
  ok(
    "requested scopes equal hubspot-app requiredScopes",
    appScopes.length === REQUIRED_SCOPES.length &&
      REQUIRED_SCOPES.every((s) => appScopes.includes(s)),
  );
  const authorize = new URL(authorizeUrlBase()!);
  ok(
    "authorize URL carries client id, redirect and scopes but no state",
    authorize.searchParams.get("client_id") === "verify-client-id" &&
      authorize.searchParams.get("redirect_uri") === process.env.HUBSPOT_REDIRECT_URI &&
      authorize.searchParams.get("scope")?.split(" ").length === REQUIRED_SCOPES.length &&
      !authorize.searchParams.has("state"),
  );

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await createOrganization({ name: `HS Sync ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "HS Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const other = await createBusiness({
    organizationId: orgId,
    name: "No HubSpot",
    defaultCurrency: "USD",
    livemode: "test",
  });

  // 3a. No connection yet → no queue rows.
  await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `before-${RUN}@x.test`,
  });
  ok("an event before connecting queues nothing", (await count(orgId, hubspotSyncQueue)) === 0);

  // 2. Connect.
  let conn = await connectHubSpot({
    organizationId: orgId,
    businessId: biz.id,
    code: "good-code",
    apiBase,
  });
  // Companies are phase 2's (verify:hubspot-customers); this suite pushes contacts only.
  conn = (await updateConnection(orgId, biz.id, {
    settings: { customers: { companyMatch: null } },
  }))!;
  ok(
    "connect stores the portal from the token",
    conn.portalId === "424242" && conn.hubDomain === "verify.hubspot.test",
  );
  ok(
    "tokens are encrypted at rest",
    !!conn.accessTokenEnc?.startsWith("v1:") &&
      !conn.accessTokenEnc.includes(`at-${RUN}`) &&
      !!conn.refreshTokenEnc?.startsWith("v1:"),
  );
  const exchange = hits.find((h) => h.path === "/oauth/v1/token");
  ok(
    "code exchange sends our redirect URI and secret, form-encoded",
    exchange?.body.grant_type === "authorization_code" &&
      exchange?.body.redirect_uri === process.env.HUBSPOT_REDIRECT_URI &&
      exchange?.body.client_secret === "verify-client-secret",
  );

  // 3b. Events queue, coalesced per customer; other businesses queue nothing.
  const cust = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `Ada-${RUN}@X.test`,
    firstName: "Ada",
    lastName: "Lovelace",
  });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    company: "Engines",
  });
  await createCustomer({
    organizationId: orgId,
    businessId: other.id,
    email: `elsewhere-${RUN}@x.test`,
  });
  const queued = await withTenant(orgId, (tx) =>
    tx.select().from(hubspotSyncQueue).where(eq(hubspotSyncQueue.resourceId, cust.id)),
  );
  ok("a burst of events on one customer is one queue row", queued.length === 1);
  ok("a business without HubSpot queues nothing", (await count(orgId, hubspotSyncQueue)) === 1);

  // First-sync gate: a new connection writes nothing until the merchant starts it.
  const due = (list: Array<{ id: string }>) => list.some((c) => c.id === conn.id);
  ok(
    "a new connection waits: neither scheduler picks it up, even with queued records",
    conn.initialSync === "pending" &&
      !due(await connectionsWithDueWork()) &&
      !due(await autosyncConnections()),
  );
  const started = await startFirstSync(orgId, biz.id);
  const again = await startFirstSync(orgId, biz.id);
  ok(
    "starting the first sync leaves pending once; a second call is a no-op",
    started?.initialSync === "queued" && again === null,
  );
  ok(
    "once started, the per-minute tick picks the connection up",
    due(await connectionsWithDueWork()),
  );
  conn = (await getConnection(orgId, biz.id))!;

  // 4. First push creates the contact, matched on the lowercased email.
  hits.length = 0;
  let r = await runSync(conn, "event");
  const search = hits.find((h) => h.path === "/crm/v3/objects/contacts/search");
  const upsert = hits.find((h) => h.method === "POST" && h.path === "/crm/v3/objects/contacts");
  const input = upsert?.body.properties as Record<string, string> | undefined;
  ok(
    "first push searches by email, then creates with the customer's fields",
    JSON.stringify(search?.body.filterGroups).includes(`"ada-${RUN}@x.test"`) &&
      input?.email === `ada-${RUN}@x.test` &&
      input.firstname === "Ada" &&
      input.company === "Engines",
  );
  ok("the push authenticates with the stored token", upsert?.auth === `Bearer at-${RUN}-1`);
  ok("the run records one created record", r.created === 1 && r.run?.status === "succeeded");
  ok(
    "a link is stored and the queue drained",
    (await count(orgId, hubspotLinks)) === 1 && (await count(orgId, hubspotSyncQueue)) === 0,
  );

  // An idle event pass writes no run row.
  const runsBefore = await withTenant(orgId, (tx) => tx.select().from(hubspotSyncRuns));
  r = await runSync(conn, "event");
  const runsAfter = await withTenant(orgId, (tx) => tx.select().from(hubspotSyncRuns));
  ok("an idle event pass leaves no run", r.run === null && runsAfter.length === runsBefore.length);

  // Unchanged record → no API call.
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    // A no-op edit emits nothing, so touch a field HubSpot does not sync to queue the record.
    invoiceNotes: "queued, nothing synced changed",
  });
  hits.length = 0;
  r = await runSync(conn, "event");
  ok(
    "an unchanged record costs no API call",
    hits.every((h) => !h.path.startsWith("/crm/")) && r.skipped === 1,
  );

  // Changed record → PATCH the linked contact.
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    lastName: "King",
  });
  hits.length = 0;
  r = await runSync(conn, "event");
  const contactId = contactsByEmail.get(`ada-${RUN}@x.test`)!;
  ok(
    "a changed record PATCHes the linked contact",
    hits.some((h) => h.method === "PATCH" && h.path === `/crm/v3/objects/contacts/${contactId}`) &&
      r.updated === 1,
  );

  // 5a. An expiring token is refreshed before the call.
  await withTenant(orgId, (tx) =>
    tx
      .update(hubspotConnections)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(hubspotConnections.id, conn.id)),
  );
  conn = (await getConnection(orgId, biz.id))!;
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    firstName: "Augusta",
  });
  hits.length = 0;
  await runSync(conn, "event");
  const refresh = hits.find((h) => h.path === "/oauth/v1/token");
  const patched = hits.find((h) => h.method === "PATCH");
  ok(
    "an expired token is refreshed and the new one used",
    refresh?.body.grant_type === "refresh_token" && patched?.auth === `Bearer at-${RUN}-2`,
  );
  conn = (await getConnection(orgId, biz.id))!;

  // 5b. 429 is waited out within the same attempt.
  script.push({
    match: "PATCH /crm/v3/objects/contacts/",
    status: 429,
    headers: { "retry-after": "1" },
  });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    phone: "+1 555 0100",
  });
  r = await runSync(conn, "event");
  ok("a 429 is waited out and the push lands", r.updated === 1 && r.failed === 0);

  // 5c. 5xx → failed, kept for a later attempt with backoff.
  script.push({ match: "PATCH /crm/v3/objects/contacts/", status: 503 });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    phone: "+1 555 0101",
  });
  r = await runSync(conn, "event");
  const [retry] = await withTenant(orgId, (tx) => tx.select().from(hubspotSyncQueue));
  ok(
    "a 5xx is retried later, not dropped",
    r.failed === 1 &&
      r.run?.status === "partial" &&
      !!retry &&
      retry.lockedAt === null &&
      retry.attempts === 1 &&
      retry.nextAttemptAt.getTime() > Date.now() + 30_000,
  );
  await withTenant(orgId, (tx) => tx.update(hubspotSyncQueue).set({ nextAttemptAt: new Date() }));
  r = await runSync(conn, "event");
  ok(
    "the retry succeeds once HubSpot recovers",
    r.updated === 1 && (await count(orgId, hubspotSyncQueue)) === 0,
  );

  // 5d. 400 → terminal: logged, not retried.
  script.push({
    match: "PATCH /crm/v3/objects/contacts/",
    status: 400,
    body: { message: "Property values were not valid" },
  });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    phone: "+1 555 0102",
  });
  r = await runSync(conn, "event");
  const items = await withTenant(orgId, (tx) =>
    tx.select().from(hubspotSyncItems).where(eq(hubspotSyncItems.runId, r.run!.id)),
  );
  ok(
    "a 400 is terminal and its reason is in the sync log",
    r.failed === 1 &&
      (await count(orgId, hubspotSyncQueue)) === 0 &&
      items.some((i) => i.action === "failed" && i.message === "Property values were not valid"),
  );

  // 4b. Contact deleted in HubSpot → re-matched by email.
  deletedContacts.add(contactId);
  contactsByEmail.delete(`ada-${RUN}@x.test`);
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    phone: "+1 555 0103",
  });
  r = await runSync(conn, "event");
  const [link] = await withTenant(orgId, (tx) =>
    tx.select().from(hubspotLinks).where(eq(hubspotLinks.localId, cust.id)),
  );
  ok(
    "a contact deleted in HubSpot is re-created and relinked",
    r.created === 1 && !!link && link.remoteId !== contactId,
  );

  // No email → skipped with a reason.
  await createCustomer({ organizationId: orgId, businessId: biz.id, firstName: "Nomail" });
  r = await runSync(conn, "event");
  const noMail = await withTenant(orgId, (tx) =>
    tx.select().from(hubspotSyncItems).where(eq(hubspotSyncItems.runId, r.run!.id)),
  );
  ok(
    "a customer with no email is skipped with a reason",
    noMail.some((i) => i.action === "skipped" && /no email/.test(i.message ?? "")),
  );

  // Full sweep reaches customers created before the connection, and marks the initial sync done.
  r = await runSync(conn, "initial", { full: true });
  conn = (await getConnection(orgId, biz.id))!;
  ok(
    "the full sweep pushes pre-existing customers and completes the initial sync",
    contactsByEmail.has(`before-${RUN}@x.test`) && conn.initialSync === "done",
  );
  conn = await connectHubSpot({
    organizationId: orgId,
    businessId: biz.id,
    code: "again",
    apiBase,
  });
  ok(
    "reconnecting the portal it already synced keeps the first sync done",
    conn.initialSync === "done",
  );
  await withTenant(orgId, (tx) =>
    tx
      .update(hubspotConnections)
      .set({ initialSync: "running" })
      .where(eq(hubspotConnections.id, conn.id)),
  );
  conn = (await getConnection(orgId, biz.id))!;
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    phone: "+1 555 0110",
  });
  await runSync(conn, "event");
  conn = (await getConnection(orgId, biz.id))!;
  ok(
    "a first sync outlasting its own job is completed by the run that drains the queue",
    conn.initialSync === "done",
  );
  const [stale] = await withTenant(orgId, (tx) =>
    tx
      .insert(hubspotSyncRuns)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        connectionId: conn.id,
        publicId: `hsr_stale_${RUN}`,
        trigger: "event",
        startedAt: new Date(Date.now() - 30 * 60_000),
      })
      .returning(),
  );
  const [fresh] = await withTenant(orgId, (tx) =>
    tx
      .insert(hubspotSyncRuns)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        connectionId: conn.id,
        publicId: `hsr_fresh_${RUN}`,
        trigger: "manual",
      })
      .returning(),
  );
  await runSync(conn, "autosync");
  const after = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(hubspotSyncRuns)
      .where(inArray(hubspotSyncRuns.id, [stale!.id, fresh!.id])),
  );
  ok(
    "a run abandoned mid-way is closed as interrupted; one still inside its time is left running",
    after.find((r) => r.id === stale!.id)?.status === "interrupted" &&
      !!after.find((r) => r.id === stale!.id)?.finishedAt &&
      after.find((r) => r.id === fresh!.id)?.status === "running",
  );

  // 6. Revoked grant → reconnect required, attempts not burned.
  await withTenant(orgId, (tx) =>
    tx
      .update(hubspotConnections)
      .set({ tokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(hubspotConnections.id, conn.id)),
  );
  conn = (await getConnection(orgId, biz.id))!;
  script.push({
    match: "POST /oauth/v1/token",
    status: 400,
    body: { status: "BAD_REFRESH_TOKEN" },
  });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    phone: "+1 555 0104",
  });
  r = await runSync(conn, "event");
  conn = (await getConnection(orgId, biz.id))!;
  const [held] = await withTenant(orgId, (tx) => tx.select().from(hubspotSyncQueue));
  ok(
    "a revoked grant flags the connection for reconnect",
    conn.status === "reauth_required" && r.run?.status === "failed",
  );
  ok(
    "the revoked pass returns its claims unburned",
    !!held && held.lockedAt === null && held.attempts === 0,
  );

  // 7. Disconnect.
  await withTenant(orgId, (tx) =>
    tx
      .update(hubspotConnections)
      .set({ status: "active" })
      .where(eq(hubspotConnections.id, conn.id)),
  );

  // A draining worker: the pass claims nothing, calls nothing and leaves the queue as it was.
  // Last engine call in this suite — the flag is process-wide and never resets.
  conn = (await getConnection(orgId, biz.id))!;
  const [queuedBefore] = await withTenant(orgId, (tx) => tx.select().from(hubspotSyncQueue));
  beginShutdown();
  hits.length = 0;
  const drained = await runSync(conn, "event");
  const [queuedAfter] = await withTenant(orgId, (tx) => tx.select().from(hubspotSyncQueue));
  ok(
    "a pass during worker shutdown makes no HubSpot calls and returns its claims unburned",
    !!queuedBefore &&
      hits.every((h) => !h.path.startsWith("/crm/")) &&
      drained.run === null &&
      queuedAfter?.id === queuedBefore.id &&
      queuedAfter.lockedAt === null &&
      queuedAfter.attempts === queuedBefore.attempts,
  );

  hits.length = 0;
  conn = (await disconnectHubSpot(orgId, biz.id))!;
  ok(
    "disconnect revokes at HubSpot and clears tokens and queue",
    hits.some((h) => h.method === "DELETE" && h.path === `/oauth/v1/refresh-tokens/rt-${RUN}`) &&
      conn.status === "disconnected" &&
      conn.accessTokenEnc === null &&
      conn.refreshTokenEnc === null &&
      (await count(orgId, hubspotSyncQueue)) === 0,
  );
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: cust.publicId,
    phone: "+1 555 0105",
  });
  ok("a disconnected business queues nothing", (await count(orgId, hubspotSyncQueue)) === 0);
  ok("links survive a disconnect", (await count(orgId, hubspotLinks)) >= 2);

  // RLS: another organization sees none of it.
  const stranger = await createOrganization({ name: `HS Stranger ${RUN}` });
  const seen = await withTenant(stranger.organization.id, (tx) =>
    tx.select().from(hubspotConnections),
  );
  ok("another organization cannot read the connection", seen.length === 0);
}

try {
  await main();
} finally {
  server.close();
  await closeDb();
}

let failed = 0;
for (const [name, pass] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "✅" : "❌"} ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
console.log(failed ? "❌ HUBSPOT-SYNC: FAIL" : "✅ HUBSPOT-SYNC: PASS");
process.exit(failed ? 1 : 0);
