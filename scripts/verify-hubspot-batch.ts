/**
 * HubSpot sync: batched customer pushes — against a local stand-in for HubSpot. No request
 * leaves this process.
 *
 * What regresses without this:
 *  1. a batch of customers costs one search per record again instead of one IN search per batch.
 *  2. the batch path links or reports a customer differently from the single-record path.
 *  3. fill_empty overwrites a matched record's filled properties inside a batch.
 *  4. one duplicate unique value, a 409, or a failed batch call costs the whole batch.
 *  5. an unchanged batch calls HubSpot, or a changed one is not a single batch update.
 *  6. the full sweep queues subscriptions or prices that cannot sync.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-batch
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Pinned, not inherited from .env: config is read at import, and a real secret must never be sent to the stand-in.
process.env.HUBSPOT_CLIENT_ID = "verify-client-id";
process.env.HUBSPOT_CLIENT_SECRET = "verify-client-secret";
process.env.HUBSPOT_REDIRECT_URI = "http://localhost:4100/integrations/hubspot/callback";

const { and, eq } = await import("drizzle-orm");
const { closeDb, withTenant } = await import("@/platform/db");
const { createOrganization, createBusiness } = await import("@/modules/tenancy/service");
const { createCustomer, updateCustomer } = await import("@/modules/customers/service");
const { createDefinition } = await import("@/modules/custom-fields/service");
await import("@/modules/integrations/sink");
const { REQUIRED_SCOPES } = await import("@/modules/hubspot/oauth");
const { connectHubSpot, getConnection, updateConnection } =
  await import("@/modules/hubspot/connections");
const { runSync } = await import("@/modules/hubspot/sync/engine");
const { pushCustomer } = await import("@/modules/hubspot/sync/customers");
const { HubSpotClient, RateWindow } = await import("@/modules/hubspot/client");
const { parseSettings } = await import("@/modules/hubspot/settings");
const { hubspotConnections, hubspotLinks, hubspotSyncItems, hubspotSyncQueue, subscriptions } =
  await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);
/** A company property holding one customer's email, as a portal would name it. */
const CO_EMAIL = `billing_email_${RUN}`;
const UNIQUE = "unique_ref";

type Props = Record<string, string>;
type Hit = { method: string; path: string; body: Record<string, unknown> };
const hits: Hit[] = [];
const script: Array<{ match: string; status: number; body?: unknown }> = [];
let nextId = 9000;
const store = { contacts: new Map<string, Props>(), companies: new Map<string, Props>() };
const associations: string[] = [];
type Obj = keyof typeof store;

function seed(object: Obj, props: Props, id = String(nextId++)): string {
  store[object].set(id, { ...props });
  return id;
}

const pick = (p: Props, want: string[]) =>
  Object.fromEntries(want.map((k) => [k, p[k] ?? null])) as Record<string, string | null>;

/** HubSpot's refusal of a value another record holds in a unique property; null when free. */
function uniqueClash(props: Props, self?: string): string | null {
  const v = props[UNIQUE];
  if (!v) return null;
  const holder = [...store.contacts].find(([id, c]) => id !== self && c[UNIQUE] === v);
  return holder
    ? `Cannot set PropertyValueCoordinates{portalId=525252, objectTypeId=ObjectTypeId{legacyObjectType=CONTACT}, propertyName=${UNIQUE}, value=${v}} on ${self ?? "new"}. ${holder[0]} already has that value.`
    : null;
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    let body: Record<string, unknown> = {};
    try {
      body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    } catch {}
    hits.push({ method, path, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload ?? {}));
    };
    const i = script.findIndex((s) => `${method} ${path}` === s.match);
    if (i >= 0) {
      const s = script.splice(i, 1)[0]!;
      return send(s.status, s.body ?? { message: `scripted ${s.status}` });
    }

    if (method === "POST" && path === "/oauth/v1/token")
      return send(200, { access_token: `at-${RUN}`, refresh_token: `rt-${RUN}`, expires_in: 1800 });
    if (method === "GET" && path.startsWith("/oauth/v1/access-tokens/"))
      return send(200, {
        hub_id: 525252,
        hub_domain: "verify.hubspot.test",
        user: "ops@verify.test",
        scopes: [...REQUIRED_SCOPES],
      });
    if (method === "GET" && /^\/crm\/v3\/properties\/\w+$/.test(path))
      return send(200, { results: [] });

    if (
      method === "POST" &&
      path === "/crm/v4/associations/contacts/companies/batch/associate/default"
    ) {
      for (const x of body.inputs as Array<{ from: { id: string }; to: { id: string } }>)
        associations.push(`${x.from.id}->${x.to.id}`);
      return send(200, { status: "COMPLETE", results: [] });
    }
    const assoc =
      /^\/crm\/v4\/objects\/contacts\/([^/]+)\/associations\/default\/companies\/([^/]+)$/.exec(
        path,
      );
    if (method === "PUT" && assoc) {
      associations.push(`${assoc[1]}->${assoc[2]}`);
      return send(200, {});
    }

    const search = /^\/crm\/v3\/objects\/(contacts|companies)\/search$/.exec(path);
    if (method === "POST" && search) {
      const f = (
        body.filterGroups as Array<{
          filters: Array<{
            propertyName: string;
            operator: string;
            value?: string;
            values?: string[];
          }>;
        }>
      )[0]!.filters[0]!;
      const want = (body.properties as string[]) ?? [];
      const values =
        f.operator === "IN" ? f.values! : f.operator === "EQ" ? [f.value!.toLowerCase()] : [];
      if (f.operator === "IN" && values.some((v) => v !== v.toLowerCase()))
        return send(400, { message: "IN values must be lowercase" });
      const all = [...store[search[1] as Obj]]
        .filter(([, p]) => values.includes((p[f.propertyName] ?? "").toLowerCase()))
        .map(([id, p]) => ({ id, properties: pick(p, want) }));
      const start = Number(body.after ?? 0);
      const limit = Number(body.limit ?? 10);
      const page = all.slice(start, start + limit);
      return send(200, {
        total: all.length,
        results: page,
        ...(start + limit < all.length
          ? { paging: { next: { after: String(start + limit) } } }
          : {}),
      });
    }

    const batch = /^\/crm\/v3\/objects\/(contacts|companies)\/batch\/(create|update|read)$/.exec(
      path,
    );
    if (method === "POST" && batch) {
      const object = batch[1] as Obj;
      const inputs = body.inputs as Array<{
        id?: string;
        properties?: Props;
        objectWriteTraceId?: string;
      }>;
      if (inputs.length > 100) return send(400, { message: "Too many inputs" });
      if (batch[2] === "read")
        return send(200, {
          status: "COMPLETE",
          results: inputs
            .filter((x) => store[object].has(x.id!))
            .map((x) => ({
              id: x.id,
              properties: pick(store[object].get(x.id!)!, body.properties as string[]),
            })),
        });
      // A unique-value clash fails the whole call, as HubSpot does.
      if (object === "contacts")
        for (const x of inputs) {
          const clash = uniqueClash(x.properties ?? {}, x.id);
          if (clash)
            return send(400, { status: "error", category: "VALIDATION_ERROR", message: clash });
        }
      if (batch[2] === "update") {
        const missing = inputs.filter((x) => !store[object].has(x.id!));
        if (missing.length)
          return send(404, {
            message: "Some objects were not found",
            errors: [{ message: "not found", context: { ids: missing.map((x) => x.id) } }],
          });
        for (const x of inputs) Object.assign(store[object].get(x.id!)!, x.properties);
        return send(200, {
          status: "COMPLETE",
          results: inputs.map((x) => ({ id: x.id, properties: store[object].get(x.id!) })),
        });
      }
      // create: a contact whose email exists fails alone (207), naming the holder.
      const results: unknown[] = [];
      const errors: unknown[] = [];
      for (const x of inputs) {
        const p = x.properties ?? {};
        const dup =
          object === "contacts" && p.email
            ? [...store.contacts].find(([, c]) => c.email === p.email)
            : undefined;
        if (dup)
          errors.push({
            status: "error",
            category: "CONFLICT",
            message: `Contact already exists. Existing ID: ${dup[0]}`,
            context: { objectWriteTraceId: [x.objectWriteTraceId] },
          });
        else results.push({ id: seed(object, p), properties: p });
      }
      return send(errors.length ? 207 : 201, {
        status: "COMPLETE",
        results,
        ...(errors.length ? { errors, numErrors: errors.length } : {}),
      });
    }

    // Single-record endpoints, for the fallback path.
    const target = /^\/crm\/v3\/objects\/contacts(?:\/([^/]+))?$/.exec(path);
    if ((method === "POST" || method === "PATCH") && target) {
      const clash = uniqueClash((body.properties ?? {}) as Props, target[1]);
      if (clash)
        return send(400, { status: "error", category: "VALIDATION_ERROR", message: clash });
    }
    const create = /^\/crm\/v3\/objects\/(contacts|companies)$/.exec(path);
    if (method === "POST" && create) {
      const p = (body.properties ?? {}) as Props;
      if (create[1] === "contacts" && p.email) {
        const dup = [...store.contacts].find(([, c]) => c.email === p.email);
        if (dup) return send(409, { message: `Contact already exists. Existing ID: ${dup[0]}` });
      }
      return send(201, { id: seed(create[1] as Obj, p) });
    }
    const one = /^\/crm\/v3\/objects\/(contacts|companies)\/([^/]+)$/.exec(path);
    if (one) {
      const rec = store[one[1] as Obj].get(one[2]!);
      if (!rec) return send(404, { message: "resource not found" });
      if (method === "PATCH") {
        Object.assign(rec, (body.properties ?? {}) as Props);
        return send(200, { id: one[2] });
      }
      if (method === "GET") return send(200, { id: one[2], properties: rec });
    }
    send(404, { message: `unexpected ${method} ${path}` });
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await createOrganization({ name: `HS Batch ${RUN}` });
  const orgId = org.organization.id;
  const settings = {
    customers: {
      contactMatch: { local: "email", remote: "email" },
      companyMatch: { local: "email_address", remote: CO_EMAIL },
      onMatch: "fill_empty",
      createMissing: true,
      multipleCustomersPerCompany: true,
      contactFields: [{ remote: "tm_id", local: "id", direction: "both" }],
    },
    deals: { enabled: false },
    products: { enabled: false },
  };
  const portal = async (name: string) => {
    const biz = await createBusiness({
      organizationId: orgId,
      name,
      defaultCurrency: "USD",
      livemode: "test",
    });
    await connectHubSpot({ organizationId: orgId, businessId: biz.id, code: "good-code", apiBase });
    await updateConnection(orgId, biz.id, { settings });
    return { biz, conn: (await getConnection(orgId, biz.id))! };
  };

  const calls = () => hits.filter((h) => h.path.startsWith("/crm/"));
  const at = (method: string, path: string) =>
    hits.filter((h) => h.method === method && h.path === path);
  const searches = (object: Obj) => at("POST", `/crm/v3/objects/${object}/search`);
  const items = (runId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(hubspotSyncItems).where(eq(hubspotSyncItems.runId, runId)),
    );
  const linkOf = async (customerId: string, type: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(hubspotLinks)
          .where(
            and(
              eq(hubspotLinks.localType, "customer"),
              eq(hubspotLinks.localId, customerId),
              eq(hubspotLinks.remoteType, type),
            ),
          ),
      )
    )[0];

  // ── The same book through both paths: seeded matches plus records to create.
  const people = Array.from({ length: 20 }, (_, i) => ({
    email: `p${i}-${RUN}@batch.test`,
    firstName: `First${i}`,
    lastName: i % 3 === 0 ? `Last${i}` : undefined,
    company: `Co ${i}`,
  }));
  const seedPortal = () => {
    store.contacts.clear();
    store.companies.clear();
    associations.length = 0;
    // Five existing contacts, some fields already filled; three companies holding the email.
    for (const i of [0, 3, 6, 9, 12])
      seed("contacts", { email: people[i]!.email, firstname: `Kept${i}`, lastname: "" }, `c${i}`);
    for (const i of [0, 5, 10])
      seed("companies", { name: `Existing ${i}`, [CO_EMAIL]: people[i]!.email }, `k${i}`);
  };

  const snapshot = async (
    ids: Array<{ id: string; email: string }>,
    runItems: Array<typeof hubspotSyncItems.$inferSelect>,
    publicIds: Map<string, string>,
  ) => {
    const out: string[] = [];
    for (const { id, email } of ids) {
      for (const type of ["contact", "company"] as const) {
        const link = await linkOf(id, type);
        const object = type === "contact" ? "contacts" : "companies";
        const rec = link ? store[object].get(link.remoteId) : undefined;
        const stable =
          link && /^[ck]\d+$/.test(link.remoteId) ? link.remoteId : link ? "new" : "none";
        const item = runItems.find(
          (x) => x.localRef === publicIds.get(id) && x.remoteType === type,
        );
        const props = rec
          ? Object.entries(rec)
              .filter(([k]) => k !== "tm_id")
              .sort()
          : [];
        out.push(JSON.stringify([email, type, stable, item?.action, item?.message ?? null, props]));
      }
    }
    return out;
  };

  // Single path first.
  seedPortal();
  const one = await portal("HS single");
  const oneCustomers = [];
  for (const p of people)
    oneCustomers.push(
      await createCustomer({ organizationId: orgId, businessId: one.biz.id, ...p }),
    );
  await withTenant(orgId, (tx) =>
    tx.delete(hubspotSyncQueue).where(eq(hubspotSyncQueue.connectionId, one.conn.id)),
  );
  hits.length = 0;
  const ctx = {
    client: new HubSpotClient(one.conn),
    conn: one.conn,
    settings: parseSettings(one.conn.settings),
  };
  const singleItems: Array<typeof hubspotSyncItems.$inferSelect> = [];
  for (const c of oneCustomers)
    for (const o of await pushCustomer(ctx, c.id))
      singleItems.push({
        ...o,
        localRef: o.localRef ?? null,
        remoteType: o.remoteType ?? null,
        message: o.message ?? null,
      } as typeof hubspotSyncItems.$inferSelect);
  const singleCalls = calls().length;
  const singleSnap = await snapshot(
    oneCustomers.map((c) => ({ id: c.id, email: c.email! })),
    singleItems,
    new Map(oneCustomers.map((c) => [c.id, c.publicId])),
  );
  const singleAssoc = associations.length;

  // Then the batch path, on the same portal state.
  seedPortal();
  const two = await portal("HS batch");
  let conn = two.conn;
  const bizId = two.biz.id;
  const batchCustomers = [];
  for (const p of people)
    batchCustomers.push(await createCustomer({ organizationId: orgId, businessId: bizId, ...p }));
  hits.length = 0;
  let r = await runSync(conn, "event");
  const batchItems = await items(r.run!.id);
  const batchSnap = await snapshot(
    batchCustomers.map((c) => ({ id: c.id, email: c.email! })),
    batchItems,
    new Map(batchCustomers.map((c) => [c.id, c.publicId])),
  );
  const contactSearches = searches("contacts");
  const companySearches = searches("companies");
  const inFilter = (h: Hit | undefined) =>
    (
      h?.body.filterGroups as Array<{ filters: Array<{ operator: string; values?: string[] }> }>
    )?.[0]?.filters[0];
  console.log(
    `   20 customers: batch path ${calls().length} calls (${contactSearches.length}+${companySearches.length} searches) vs single path ${singleCalls}`,
  );
  ok(
    "20 customers cost at most 2 contact and 2 company searches, each an IN filter",
    contactSearches.length >= 1 &&
      contactSearches.length <= 2 &&
      companySearches.length >= 1 &&
      companySearches.length <= 2 &&
      [...contactSearches, ...companySearches].every((h) => inFilter(h)?.operator === "IN"),
  );
  ok(
    "the IN values are the lowercased match values",
    (inFilter(contactSearches[0])?.values ?? []).includes(people[1]!.email.toLowerCase()),
  );
  ok(
    "missing records are made with one batch create per object, no single creates",
    at("POST", "/crm/v3/objects/contacts/batch/create").length === 1 &&
      at("POST", "/crm/v3/objects/companies/batch/create").length === 1 &&
      at("POST", "/crm/v3/objects/contacts").length === 0 &&
      at("POST", "/crm/v3/objects/companies").length === 0,
  );
  ok(
    "fill_empty on matched records is one batch update, no single PATCH",
    at("POST", "/crm/v3/objects/contacts/batch/update").length === 1 &&
      hits.every((h) => h.method !== "PATCH"),
  );
  ok(
    "every contact is associated to its company in one batch call",
    at("POST", "/crm/v4/associations/contacts/companies/batch/associate/default").length === 1 &&
      associations.length === 20 &&
      singleAssoc === 20,
  );
  ok(
    "the batch path links and reports every customer exactly as the single path",
    batchSnap.length === 40 && JSON.stringify(batchSnap) === JSON.stringify(singleSnap),
  );
  const firstDiff = batchSnap.findIndex((s, i) => s !== singleSnap[i]);
  if (firstDiff >= 0)
    console.log(
      `   first difference:\n   batch  ${batchSnap[firstDiff]}\n   single ${singleSnap[firstDiff]}`,
    );
  ok(
    "fill_empty keeps filled properties and fills only blanks",
    store.contacts.get("c0")!.firstname === "Kept0" &&
      store.contacts.get("c0")!.lastname === "Last0" &&
      store.contacts.get("c3")!.lastname === "Last3" &&
      batchItems.some(
        (i) =>
          i.remoteId === "c0" &&
          i.message === "Linked to an existing record. Filled 3 empty properties",
      ),
  );
  ok(
    "created records are reported as created",
    batchItems.filter((i) => i.remoteType === "contact" && i.action === "created").length === 15 &&
      batchItems.filter((i) => i.remoteType === "company" && i.action === "created").length === 17,
  );

  // ── Unchanged → no call; a change to ten customers → one batch update.
  hits.length = 0;
  for (const c of batchCustomers.slice(0, 10))
    await updateCustomer({
      organizationId: orgId,
      businessId: bizId,
      customerPublicId: c.publicId,
      firstName: `Renamed ${c.publicId}`,
    });
  for (const c of batchCustomers.slice(10))
    await updateCustomer({
      organizationId: orgId,
      businessId: bizId,
      customerPublicId: c.publicId,
      // A no-op edit emits nothing, so touch a field HubSpot does not sync to queue the record.
      invoiceNotes: "queued, nothing synced changed",
    });
  r = await runSync(conn, "event");
  ok(
    "changed linked contacts go in one batch update; unchanged ones cost nothing",
    at("POST", "/crm/v3/objects/contacts/batch/update").length === 1 &&
      (at("POST", "/crm/v3/objects/contacts/batch/update")[0]?.body.inputs as unknown[] | undefined)
        ?.length === 10 &&
      searches("contacts").length === 0 &&
      searches("companies").length === 0 &&
      calls().length === 1 &&
      r.updated === 10 &&
      r.skipped === 30,
  );

  // ── A duplicate unique value inside a batch drops that property for that record only.
  await createDefinition({
    organizationId: orgId,
    businessId: bizId,
    entityType: "customer",
    apiName: "crm_ref",
    label: "CRM ref",
    dataType: "string",
  });
  await updateConnection(orgId, bizId, {
    settings: {
      customers: {
        contactFields: [{ remote: UNIQUE, local: "cf_crm_ref", direction: "to_remote" }],
      },
    },
  });
  conn = (await getConnection(orgId, bizId))!;
  seed("contacts", { email: `holder-${RUN}@batch.test`, [UNIQUE]: `DUP-${RUN}` });
  const dupes: Array<Awaited<ReturnType<typeof createCustomer>>> = [];
  for (let i = 0; i < 6; i++)
    dupes.push(
      await createCustomer({
        organizationId: orgId,
        businessId: bizId,
        email: `u${i}-${RUN}@batch.test`,
        firstName: `U${i}`,
        customFields: { crm_ref: i === 2 ? `DUP-${RUN}` : `FREE-${i}-${RUN}` },
      }),
    );
  hits.length = 0;
  r = await runSync(conn, "event");
  let log = await items(r.run!.id);
  const dupeLink = await linkOf(dupes[2]!.id, "contact");
  const dupeItem = log.find((i) => i.localRef === dupes[2]!.publicId && i.remoteType === "contact");
  ok(
    "a duplicate unique value in a batch create: that record falls back and drops the property",
    !!dupeLink &&
      store.contacts.get(dupeLink.remoteId)?.firstname === "U2" &&
      store.contacts.get(dupeLink.remoteId)?.[UNIQUE] === undefined &&
      dupeItem?.action === "created" &&
      /Left out unique_ref/.test(dupeItem?.message ?? ""),
  );
  ok(
    "the rest of that batch is still created in batch, with their unique values",
    at("POST", "/crm/v3/objects/contacts/batch/create").length === 2 &&
      at("POST", "/crm/v3/objects/contacts").length === 2 &&
      (
        await Promise.all(dupes.filter((_, i) => i !== 2).map((d) => linkOf(d.id, "contact")))
      ).every((l) => !!l && store.contacts.get(l.remoteId)?.[UNIQUE]?.startsWith("FREE-")) &&
      log.filter((i) => i.remoteType === "contact" && i.action === "created").length === 6,
  );
  await updateConnection(orgId, bizId, { settings: { customers: { contactFields: [] } } });
  conn = (await getConnection(orgId, bizId))!;

  // ── A 409 inside a batch create is a match: read in batch, then fill_empty.
  const lagging = seed("contacts", { email: `lag-${RUN}@batch.test`, firstname: "Lagging" });
  const lagged = [];
  for (let i = 0; i < 5; i++)
    lagged.push(
      await createCustomer({
        organizationId: orgId,
        businessId: bizId,
        email: i === 0 ? `lag-${RUN}@batch.test` : `l${i}-${RUN}@batch.test`,
        firstName: `L${i}`,
        lastName: "Lag",
      }),
    );
  // Search has not caught up with the existing contact yet.
  script.push({
    match: "POST /crm/v3/objects/contacts/search",
    status: 200,
    body: { total: 0, results: [] },
  });
  hits.length = 0;
  r = await runSync(conn, "event");
  log = await items(r.run!.id);
  ok(
    "a 409 in a batch create links to the named record, read in batch, filling only blanks",
    (await linkOf(lagged[0]!.id, "contact"))?.remoteId === lagging &&
      at("POST", "/crm/v3/objects/contacts/batch/read").length === 1 &&
      store.contacts.get(lagging)!.firstname === "Lagging" &&
      store.contacts.get(lagging)!.lastname === "Lag" &&
      log.some(
        (i) =>
          i.remoteId === lagging && /^Linked to an existing record\. Filled/.test(i.message ?? ""),
      ) &&
      hits.every((h) => h.method !== "GET" || !h.path.startsWith("/crm/v3/objects")),
  );

  // ── A failed batch call falls back to one record at a time.
  const failing = [];
  for (let i = 0; i < 6; i++)
    failing.push(
      await createCustomer({
        organizationId: orgId,
        businessId: bizId,
        email: `f${i}-${RUN}@batch.test`,
        firstName: `F${i}`,
      }),
    );
  script.push({
    match: "POST /crm/v3/objects/contacts/batch/create",
    status: 500,
    body: { message: "Internal error" },
  });
  hits.length = 0;
  r = await runSync(conn, "event");
  log = await items(r.run!.id);
  ok(
    "a batch create that fails outright falls back to single creates, and every record links",
    at("POST", "/crm/v3/objects/contacts/batch/create").length === 1 &&
      at("POST", "/crm/v3/objects/contacts").length === 6 &&
      (await Promise.all(failing.map((f) => linkOf(f.id, "contact")))).every(Boolean) &&
      log.filter((i) => i.remoteType === "contact" && i.action === "created").length === 6 &&
      r.failed === 0,
  );

  // ── Two customers sharing an email in one batch link to the same records.
  const twins = [];
  for (let i = 0; i < 6; i++)
    twins.push(
      await createCustomer({
        organizationId: orgId,
        businessId: bizId,
        email: i < 2 ? `twin-${RUN}@batch.test` : `t${i}-${RUN}@batch.test`,
        firstName: `T${i}`,
      }),
    );
  hits.length = 0;
  r = await runSync(conn, "event");
  const [ta, tb] = [await linkOf(twins[0]!.id, "contact"), await linkOf(twins[1]!.id, "contact")];
  const [ka, kb] = [await linkOf(twins[0]!.id, "company"), await linkOf(twins[1]!.id, "company")];
  ok(
    "two customers with one email in a batch share one contact and one company",
    !!ta && ta.remoteId === tb?.remoteId && !!ka && ka.remoteId === kb?.remoteId && r.failed === 0,
  );

  // ── The full sweep queues only what can sync.
  const addSub = (customerId: string, status: string, extra: Record<string, unknown> = {}) =>
    withTenant(orgId, (tx) =>
      tx
        .insert(subscriptions)
        .values({
          organizationId: orgId,
          businessId: bizId,
          customerId,
          publicId: `sub_hsb_${randomUUID().slice(0, 12)}`,
          status,
          currency: "USD",
          ...extra,
        })
        .returning(),
    );
  const [active] = await addSub(batchCustomers[0]!.id, "active");
  const [cancelled] = await addSub(batchCustomers[1]!.id, "cancelled");
  const [ending] = await addSub(batchCustomers[2]!.id, "active", { cancelAtPeriodEnd: true });
  const [trial] = await addSub(batchCustomers[3]!.id, "in_trial");
  const sweep = async (patch: Record<string, unknown>) => {
    const s = { ...(conn.settings as Record<string, unknown>), ...patch };
    await withTenant(orgId, async (tx) => {
      await tx
        .update(hubspotConnections)
        .set({ settings: s })
        .where(eq(hubspotConnections.id, conn.id));
      await tx.delete(hubspotSyncQueue).where(eq(hubspotSyncQueue.connectionId, conn.id));
    });
    conn = (await getConnection(orgId, bizId))!;
    await runSync(conn, "event", { full: true, budgetMs: 0 });
    return withTenant(orgId, (tx) =>
      tx.select().from(hubspotSyncQueue).where(eq(hubspotSyncQueue.connectionId, conn.id)),
    );
  };
  let queued = await sweep({
    deals: { enabled: true, statuses: ["active", "in_trial"] },
    products: { enabled: false },
  });
  const subIds = (q: typeof queued) =>
    new Set(q.filter((x) => x.resourceType === "subscription").map((x) => x.resourceId));
  let subs = subIds(queued);
  ok(
    "the sweep queues subscriptions in the chosen statuses only (non-renewing is not active)",
    subs.has(active!.id) &&
      subs.has(trial!.id) &&
      !subs.has(cancelled!.id) &&
      !subs.has(ending!.id),
  );
  ok(
    "the sweep queues no prices while product sync is off, and every customer",
    queued.every((x) => x.resourceType !== "price") &&
      queued.filter((x) => x.resourceType === "customer").length >= 20,
  );
  queued = await sweep({ deals: { enabled: true, statuses: ["non_renewing", "cancelled"] } });
  subs = subIds(queued);
  ok(
    "non-renewing and cancelled are queued when chosen",
    subs.has(ending!.id) &&
      subs.has(cancelled!.id) &&
      !subs.has(active!.id) &&
      !subs.has(trial!.id),
  );
  queued = await sweep({ deals: { enabled: false } });
  ok("with deal sync off, the sweep queues no subscriptions", subIds(queued).size === 0);

  // ── The pacer: the fifth request inside a 4-per-second window waits out the window.
  const window = new RateWindow(4, 300);
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await window.take();
  const burst = Date.now() - t0;
  await window.take();
  ok(
    "the rate window lets a burst through and holds the next request",
    burst < 100 && Date.now() - t0 >= 290,
  );
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
console.log(failed ? "❌ HUBSPOT-BATCH: FAIL" : "✅ HUBSPOT-BATCH: PASS");
process.exit(failed ? 1 : 0);
