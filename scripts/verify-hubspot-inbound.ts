/**
 * HubSpot sync, phase 4: HubSpot → billing and the conflict rules — against a local stand-in for
 * HubSpot that serves search-by-last-modified, batch reads and keeps an updatedAt clock.
 * No request leaves this process.
 *
 * What regresses without this:
 *  1. a contact edit is not pulled (standard properties, `to_local` or `both` mappings), or a
 *     `to_remote` mapping or a blank HubSpot value overwrites ours.
 *  2. deal custom fields are not pulled, a blank deal value does not clear, or status/amount leak in.
 *  3. company edits are pulled while several customers share companies.
 *  4. "don't sync HubSpot changes" still writes, or replays the edits once turned back on.
 *  5. the watermark does not advance, stops at HubSpot's 10,000-result cap, or unlinked records are touched.
 *  6. a record changed on both sides ignores the rule: local_wins pulls, remote_wins pushes the stale
 *     value back, flag does not hold both directions, or resolving does not release it.
 *  7. a pull's own events push the pulled values straight back (the echo loop).
 *  8. pull writes are not attributed to HubSpot; conflicts leak across tenants.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-inbound
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Pinned, not inherited from .env: config is read at import, and a real secret must never be sent to the stand-in.
process.env.HUBSPOT_CLIENT_ID = "verify-client-id";
process.env.HUBSPOT_CLIENT_SECRET = "verify-client-secret";
process.env.HUBSPOT_REDIRECT_URI = "http://localhost:4100/integrations/hubspot/callback";

const { and, desc, eq, gt } = await import("drizzle-orm");
const { closeDb, withTenant } = await import("@/platform/db");
const { loadGeoReference } = await import("@/platform/geo");
const { createOrganization, createBusiness, createApiKey } =
  await import("@/modules/tenancy/service");
const { createCustomer, updateCustomer } = await import("@/modules/customers/service");
const { createProduct, createPrice } = await import("@/modules/catalog/service");
const { createSubscription } = await import("@/modules/subscriptions/service");
const { createDefinition } = await import("@/modules/custom-fields/service");
const { emitEvent } = await import("@/modules/events/emit");
const { buildApp } = await import("@/index");
await import("@/modules/integrations/sink");
const { REQUIRED_SCOPES } = await import("@/modules/hubspot/oauth");
const { getConnection, updateConnection } = await import("@/modules/hubspot/connections");
const { encryptSecret } = await import("@/platform/secrets");
const { publicId } = await import("@/platform/ids");
const { runSync } = await import("@/modules/hubspot/sync/engine");
const {
  customers,
  events,
  hubspotConflicts,
  hubspotConnections,
  hubspotLinks,
  hubspotSyncItems,
  subscriptions,
} = await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);

type Obj = "contacts" | "companies" | "deals";
type Hit = { method: string; path: string; body: Record<string, unknown> };
const hits: Hit[] = [];
let nextId = 9000;
const store: Record<Obj, Map<string, Record<string, string>>> = {
  contacts: new Map(),
  companies: new Map(),
  deals: new Map(),
};
const updated = new Map<string, number>();
const MODIFIED: Record<Obj, string> = {
  contacts: "lastmodifieddate",
  companies: "hs_lastmodifieddate",
  deals: "hs_lastmodifieddate",
};

/** HubSpot's clock: strictly increasing, and `skew` moves it ahead of ours. */
let last = 0;
let skew = 0;
const tick = () => (last = Math.max(last + 1, Date.now() + skew));

function seed(object: Obj, props: Record<string, string>): string {
  const id = String(nextId++);
  store[object].set(id, { ...props });
  updated.set(`${object}:${id}`, tick());
  return id;
}
/** An edit made by someone in HubSpot. */
function edit(object: Obj, id: string, props: Record<string, string>) {
  Object.assign(store[object].get(id)!, props);
  updated.set(`${object}:${id}`, tick());
}
const view = (object: Obj, id: string, want: string[]) => {
  const at = new Date(updated.get(`${object}:${id}`)!).toISOString();
  const p = store[object].get(id)!;
  return {
    id,
    properties: {
      ...Object.fromEntries(want.map((k) => [k, p[k] ?? null])),
      [MODIFIED[object]]: at,
    },
    updatedAt: at,
  };
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;
    let body: Record<string, unknown> = {};
    try {
      body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    } catch {}
    hits.push({ method, path, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload ?? {}));
    };

    if (method === "POST" && path === "/oauth/v1/token")
      return send(200, { access_token: `at-${RUN}`, refresh_token: `rt-${RUN}`, expires_in: 1800 });
    if (method === "GET" && path.startsWith("/oauth/v1/access-tokens/"))
      return send(200, {
        hub_id: 626262,
        hub_domain: "inbound.hubspot.test",
        user: "ops@verify.test",
        scopes: [...REQUIRED_SCOPES],
      });
    if (method === "GET" && path.startsWith("/crm/v3/properties/"))
      return send(200, { results: [] });
    if (method === "PUT" && path.startsWith("/crm/v4/objects/"))
      return send(200, { status: "COMPLETE" });
    if (method === "GET" && /^\/crm\/v4\/objects\/contacts\/\d+\/associations\/deals$/.test(path))
      return send(200, { results: [] });

    const search = /^\/crm\/v3\/objects\/(contacts|companies|deals)\/search$/.exec(path);
    if (method === "POST" && search) {
      const object = search[1] as Obj;
      const f = (
        body.filterGroups as Array<{
          filters: Array<{ propertyName: string; operator: string; value: string }>;
        }>
      )[0]!.filters[0]!;
      const want = (body.properties as string[]) ?? [];
      if (f.operator === "GT") {
        const after = Number(body.after ?? 0);
        if (after >= 10_000) return send(400, { message: "Search results are limited to 10,000" });
        const limit = Number(body.limit ?? 10);
        const all = [...store[object].keys()]
          .filter((id) => updated.get(`${object}:${id}`)! > Number(f.value))
          .sort(
            (a, b) =>
              updated.get(`${object}:${a}`)! - updated.get(`${object}:${b}`)! || a.localeCompare(b),
          );
        const page = all.slice(after, after + limit);
        return send(200, {
          total: all.length,
          results: page.map((id) => view(object, id, want)),
          ...(after + limit < all.length
            ? { paging: { next: { after: String(after + limit) } } }
            : {}),
        });
      }
      for (const [id, p] of store[object]) {
        if ((p[f.propertyName] ?? "").toLowerCase() === f.value.toLowerCase())
          return send(200, { total: 1, results: [view(object, id, want)] });
      }
      return send(200, { total: 0, results: [] });
    }

    const batch = /^\/crm\/v3\/objects\/(contacts|companies|deals)\/batch\/read$/.exec(path);
    if (method === "POST" && batch) {
      const object = batch[1] as Obj;
      const want = (body.properties as string[]) ?? [];
      const ids = ((body.inputs as Array<{ id: string }>) ?? [])
        .map((i) => String(i.id))
        .filter((id) => store[object].has(id));
      return send(200, { results: ids.map((id) => view(object, id, want)) });
    }

    const create = /^\/crm\/v3\/objects\/(contacts|companies|deals)$/.exec(path);
    if (method === "POST" && create)
      return send(201, {
        id: seed(create[1] as Obj, (body.properties ?? {}) as Record<string, string>),
      });

    const one = /^\/crm\/v3\/objects\/(contacts|companies|deals)\/(\d+)$/.exec(path);
    if (one) {
      const object = one[1] as Obj;
      if (!store[object].has(one[2]!)) return send(404, { message: "resource not found" });
      if (method === "PATCH") {
        edit(object, one[2]!, (body.properties ?? {}) as Record<string, string>);
        return send(200, { id: one[2] });
      }
      if (method === "GET")
        return send(200, view(object, one[2]!, Object.keys(store[object].get(one[2]!)!)));
    }
    send(404, { message: `unexpected ${method} ${path}` });
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Country and state parsing reads the reference data the API and worker load at boot.
  await loadGeoReference();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = await buildApp({ logger: false });

  const org = await createOrganization({ name: `HS Inbound ${RUN}` });
  const orgId = org.organization.id;
  const { secret } = await createApiKey(orgId, "test");
  const biz = await createBusiness({
    organizationId: orgId,
    name: "HS Inbound Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // Inserted directly: connectHubSpot's info log trips the cloud-logging sink in some environments.
  await withTenant(orgId, (tx) =>
    tx.insert(hubspotConnections).values({
      organizationId: orgId,
      businessId: biz.id,
      publicId: publicId("hsc"),
      portalId: "626262",
      accessTokenEnc: encryptSecret(`at-${RUN}`),
      refreshTokenEnc: encryptSecret(`rt-${RUN}`),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      status: "active",
      apiBase,
      initialSync: "done",
      scopes: [...REQUIRED_SCOPES],
    }),
  );
  let conn = (await getConnection(orgId, biz.id))!;
  const scope = { organizationId: orgId, businessId: biz.id };

  const setSettings = async (patch: Record<string, unknown>) => {
    await updateConnection(orgId, biz.id, { settings: patch });
    conn = (await getConnection(orgId, biz.id))!;
  };
  const pass = async (trigger: "manual" | "autosync" | "event" = "manual") => {
    hits.length = 0;
    conn = (await getConnection(orgId, biz.id))!;
    const r = await runSync(conn, trigger);
    const items = r.run
      ? await withTenant(orgId, (tx) =>
          tx.select().from(hubspotSyncItems).where(eq(hubspotSyncItems.runId, r.run!.id)),
        )
      : [];
    return { ...r, items };
  };
  const writes = () =>
    hits.filter(
      (h) =>
        h.path.startsWith("/crm/") &&
        (h.method === "PATCH" ||
          h.method === "PUT" ||
          (h.method === "POST" && !/\/(search|batch\/read)$/.test(h.path))),
    );
  const searches = (object: Obj) =>
    hits.filter((h) => h.method === "POST" && h.path === `/crm/v3/objects/${object}/search`);
  const customerRow = async (id: string) =>
    (await withTenant(orgId, (tx) => tx.select().from(customers).where(eq(customers.id, id))))[0]!;
  const subRow = async (id: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.id, id)),
      )
    )[0]!;
  const linkOf = async (localId: string, remoteType: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(hubspotLinks)
          .where(and(eq(hubspotLinks.localId, localId), eq(hubspotLinks.remoteType, remoteType))),
      )
    )[0]!;
  const cf = (row: { customFields: unknown }) =>
    (row.customFields ?? {}) as Record<string, unknown>;
  const local = (
    publicId: string,
    fields: Omit<
      Parameters<typeof updateCustomer>[0],
      "organizationId" | "businessId" | "customerPublicId"
    >,
  ) => updateCustomer({ ...scope, customerPublicId: publicId, ...fields });

  // ── Setup: mappings in every direction, a customer with a subscription, all linked.
  for (const apiName of ["nickname", "tier"])
    await createDefinition({
      ...scope,
      entityType: "customer",
      apiName,
      label: apiName,
      dataType: "string",
    });
  for (const apiName of ["region", "note"])
    await createDefinition({
      ...scope,
      entityType: "subscription",
      apiName,
      label: apiName,
      dataType: "string",
    });
  await setSettings({
    products: { enabled: false },
    customers: {
      contactFields: [
        { remote: "hs_nick", local: "cf_nickname", direction: "to_local" },
        { remote: "hs_tier", local: "cf_tier", direction: "both" },
        { remote: "hs_vat", local: "vat_number", direction: "to_remote" },
      ],
    },
    deals: {
      fields: [
        { remote: "deal_region", local: "cf_region", direction: "both" },
        { remote: "deal_note", local: "cf_note", direction: "to_local" },
        { remote: "deal_status_copy", local: "status", direction: "to_local" },
        { remote: "deal_mrr_copy", local: "mrr", direction: "both" },
      ],
    },
  });
  const product = await createProduct({ ...scope, name: "Inbound Plan" });
  const price = await createPrice({
    ...scope,
    productId: product.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 4200,
    interval: "month",
  });
  const a = await createCustomer({
    ...scope,
    email: `ada@a-${RUN}.test`,
    firstName: "Ada",
    lastName: "Lovelace",
    company: "Analytical",
    phone: "+1 555 0100",
    vatNumber: "VAT-OURS",
    customFields: { tier: "gold" },
  });
  const sub = (
    await createSubscription({
      ...scope,
      customerId: a.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    })
  ).subscription;
  await pass("event");
  const contactId = (await linkOf(a.id, "contact"))?.remoteId;
  const companyId = (await linkOf(a.id, "company"))?.remoteId;
  const dealId = (await linkOf(sub.id, "deal"))?.remoteId;
  ok(
    "setup: the customer's contact and company and the subscription's deal are linked",
    !!contactId && !!companyId && !!dealId,
  );

  // ── First sighting of our own write is recorded, not pulled.
  store.contacts.get(contactId!)!.hs_nick = "pre-existing";
  let r = await pass();
  const cSearch = searches("contacts")[0]?.body;
  const cFilter = (
    cSearch?.filterGroups as Array<{ filters: Array<Record<string, string>> }> | undefined
  )?.[0]?.filters[0];
  const cProps = (cSearch?.properties as string[] | undefined) ?? [];
  ok(
    "contacts are searched GT the watermark on lastmodifieddate, oldest first, 100 per page",
    cFilter?.propertyName === "lastmodifieddate" &&
      cFilter.operator === "GT" &&
      cSearch?.limit === 100 &&
      (cSearch?.sorts as Array<Record<string, string>>)?.[0]?.direction === "ASCENDING",
  );
  ok(
    "only pulled properties are requested (no to_remote-only mapping)",
    cProps.includes("firstname") &&
      cProps.includes("hs_nick") &&
      cProps.includes("hs_tier") &&
      !cProps.includes("hs_vat"),
  );
  const dProps = (searches("deals")[0]?.body.properties as string[] | undefined) ?? [];
  const dFilter = (
    searches("deals")[0]?.body.filterGroups as
      | Array<{ filters: Array<Record<string, string>> }>
      | undefined
  )?.[0]?.filters[0];
  ok(
    "companies and deals are searched on hs_lastmodifieddate",
    dFilter?.propertyName === "hs_lastmodifieddate" &&
      (
        searches("companies")[0]?.body.filterGroups as
          | Array<{ filters: Array<Record<string, string>> }>
          | undefined
      )?.[0]?.filters[0]?.propertyName === "hs_lastmodifieddate",
  );
  ok(
    "deal status, amount and MRR are never requested for a pull",
    dProps.includes("deal_region") &&
      dProps.includes("deal_note") &&
      !dProps.includes("deal_status_copy") &&
      !dProps.includes("deal_mrr_copy") &&
      !dProps.includes("amount") &&
      !dProps.includes("dealstage"),
  );
  const baselined = await linkOf(a.id, "contact");
  ok(
    "a first sighting of our own push is a baseline: stored, nothing written",
    cf(await customerRow(a.id)).nickname === undefined &&
      baselined.remoteValues?.hs_nick === "pre-existing" &&
      !!baselined.remoteUpdatedAt,
  );

  // ── A contact edit: standard, to_local and both pulled; to_remote and blanks are not.
  const since = new Date();
  edit("contacts", contactId!, {
    firstname: "Adaline",
    phone: "+1 555 0200",
    hs_nick: "Addy",
    hs_tier: "platinum",
    hs_vat: "VAT-THEIRS",
    lastname: "",
  });
  r = await pass();
  let ca = await customerRow(a.id);
  ok(
    "a contact edit is pulled into the customer (standard properties)",
    ca.firstName === "Adaline" && ca.phone === "+1 555 0200",
  );
  ok("a to_local mapping is pulled", cf(ca).nickname === "Addy");
  ok("a both mapping is pulled", cf(ca).tier === "platinum");
  ok("a to_remote-only mapping is not pulled", ca.vatNumber === "VAT-OURS");
  ok("a blank HubSpot value does not overwrite ours", ca.lastName === "Lovelace");

  ok(
    "the pull is on the sync log",
    r.items.some(
      (i) =>
        i.action === "updated" &&
        i.remoteId === contactId &&
        /Pulled from HubSpot/.test(i.message ?? ""),
    ),
  );
  ok("no echo: the pull's own events push nothing back in the same pass", writes().length === 0);
  const evs = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.businessId, biz.id), gt(events.createdAt, since)))
      .orderBy(desc(events.createdAt)),
  );
  const pulledEvent = evs.find((e) => e.type === "customer_updated");
  ok(
    "the pull's events carry source hubspot and the portal as actor",
    pulledEvent?.source === "hubspot" && pulledEvent.actor === `hubspot:${conn.portalId}:sync`,
  );
  r = await pass();
  ok(
    "no echo: the next pass neither writes nor pulls again",
    writes().length === 0 && !r.items.some((i) => i.action === "updated"),
  );
  // ── Address and email are not pulled by default; the rest of the same edit is.
  const heldEmail = `ada.hs@a-${RUN}.test`;
  edit("contacts", contactId!, {
    firstname: "Adela",
    city: "Pune",
    country: "FR",
    email: heldEmail,
  });
  r = await pass();
  ca = await customerRow(a.id);
  ok(
    "by default a HubSpot address or email edit is not pulled, while a name edit alongside it is",
    ca.firstName === "Adela" && ca.city === null && ca.country === null && ca.email === a.email,
  );
  ok(
    "the held fields are not reported as pulled",
    r.items.some(
      (i) =>
        i.remoteId === contactId &&
        i.action === "updated" &&
        !/Email|Billing/.test(i.message ?? ""),
    ),
  );
  edit("contacts", contactId!, { city: "Nagpur" });
  r = await pass();
  ok(
    "an edit touching only held fields writes nothing and logs no update or failure",
    (await customerRow(a.id)).city === null &&
      !r.items.some((i) => i.remoteId === contactId) &&
      writes().length === 0,
  );
  await setSettings({ updates: { pullAddress: true } });
  edit("contacts", contactId!, { firstname: "Adaline" });
  await pass();
  ca = await customerRow(a.id);
  ok(
    "turning address pulls on does not replay edits made while off",
    ca.firstName === "Adaline" && ca.city === null && ca.country === null,
  );

  // ── HubSpot's country and state are free text: names map to codes; the rest is not stored.
  edit("contacts", contactId!, { country: "India", state: "Tamil Nadu", city: "Chennai" });
  await pass();
  ca = await customerRow(a.id);
  ok(
    "a country name from HubSpot is stored as its ISO code, and a state name as its subdivision code",
    ca.country === "IN" && ca.stateCode === "TN" && ca.city === "Chennai",
  );
  edit("contacts", contactId!, { country: "Atlantis", city: "Madurai" });
  r = await pass();
  ca = await customerRow(a.id);
  ok(
    "an unrecognised country is left out without failing the rest of the pull",
    ca.country === "IN" && ca.city === "Madurai" && !r.items.some((i) => i.action === "failed"),
  );
  edit("contacts", contactId!, { country: "GB", state: "County Antrim" });
  await pass();
  ca = await customerRow(a.id);
  ok(
    "a state that names no listed subdivision never becomes a tax code",
    ca.country === "GB" && ca.stateCode !== "COUNTY ANTRIM",
  );
  ok("with pullEmail off, the email is still ours", ca.email === a.email);
  await setSettings({ updates: { pullEmail: true } });
  const pulledEmail = `ada.pulled@a-${RUN}.test`;
  edit("contacts", contactId!, { email: pulledEmail });
  await pass();
  ok(
    "with pullEmail on, a HubSpot email edit is pulled",
    (await customerRow(a.id)).email === pulledEmail,
  );

  // ── Deals: custom fields in, blanks clear, status and money never.
  const before = await subRow(sub.id);
  edit("deals", dealId!, {
    deal_region: "EMEA",
    deal_note: "hello",
    amount: "999",
    dealstage: "closedlost",
    deal_status_copy: "cancelled",
    deal_mrr_copy: "1",
  });
  await pass();
  let s1 = await subRow(sub.id);
  ok(
    "deal custom fields are pulled into the subscription",
    cf(s1).region === "EMEA" && cf(s1).note === "hello",
  );
  ok(
    "deal status and amount are never pulled",
    s1.status === before.status && s1.mrr === before.mrr && cf(s1).status === undefined,
  );
  await withTenant(orgId, (tx) =>
    emitEvent(tx, {
      ...scope,
      type: "subscription_changed",
      data: { subscription: { id: sub.publicId } },
      resource: { type: "subscription", id: sub.publicId },
    }),
  );
  await pass("event");
  ok("no echo: a later push of the subscription sends nothing back", writes().length === 0);
  edit("deals", dealId!, { deal_note: "" });
  await pass();
  s1 = await subRow(sub.id);
  ok("a blank deal value clears ours", cf(s1).note === undefined && cf(s1).region === "EMEA");

  // ── A company edit (not shared): its name becomes ours; autosync pulls too.
  edit("companies", companyId!, { name: "Analytical Engines" });
  r = await pass("autosync");
  ca = await customerRow(a.id);
  ok("autosync pulls: a company rename lands on the customer", ca.company === "Analytical Engines");
  ok(
    "the rename then flows to the contact's company text",
    store.contacts.get(contactId!)!.company === "Analytical Engines",
  );

  // ── remoteChange "nothing": no reads, no writes, and the edit is consumed.
  await setSettings({ updates: { remoteChange: "nothing" } });
  edit("contacts", contactId!, { firstname: "Ignored" });
  await sleep(20);
  const offAt = Date.now();
  await pass();
  const offMark = (await getConnection(orgId, biz.id))!.contactsWatermark?.getTime() ?? 0;
  ok(
    "with HubSpot changes off, the watermark still advances to now",
    offMark >= offAt && offMark <= Date.now(),
  );
  ok(
    "with HubSpot changes off, nothing is read or written",
    searches("contacts").length === 0 && (await customerRow(a.id)).firstName === "Adaline",
  );
  await setSettings({ updates: { remoteChange: "overwrite_local" } });
  await pass();
  ok(
    "turning it back on does not replay edits made while off",
    (await customerRow(a.id)).firstName === "Adaline",
  );

  // ── Conflicts: local_wins.
  await setSettings({ updates: { conflict: "local_wins" } });
  await local(a.publicId, { firstName: "LocalA" });
  edit("contacts", contactId!, { firstname: "RemoteA" });
  r = await pass();
  ok(
    "local_wins: ours is kept and pushed over HubSpot's",
    (await customerRow(a.id)).firstName === "LocalA" &&
      store.contacts.get(contactId!)!.firstname === "LocalA" &&
      r.items.some((i) => /kept ours/.test(i.message ?? "")),
  );

  // ── remote_wins: HubSpot's value lands, and the queued push carries it, not the stale one.
  await setSettings({ updates: { conflict: "remote_wins" } });
  await local(a.publicId, { firstName: "LocalB", phone: "+1 555 0300" });
  edit("contacts", contactId!, { firstname: "RemoteB" });
  await pass();
  ok(
    "remote_wins: HubSpot's value is applied and the push does not send the stale local one",
    (await customerRow(a.id)).firstName === "RemoteB" &&
      store.contacts.get(contactId!)!.firstname === "RemoteB" &&
      store.contacts.get(contactId!)!.phone === "+1 555 0300",
  );

  // ── flag: a conflict row, both directions held, then resolved over the API.
  await setSettings({ updates: { conflict: "flag" } });
  const api = (method: "GET" | "POST", path: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/v1/businesses/${biz.publicId}/integrations/hubspot${path}`,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  await local(a.publicId, { firstName: "LocalC" });
  edit("contacts", contactId!, { firstname: "RemoteC" });
  r = await pass();
  const listed = (await api("GET", "/conflicts")).json() as {
    data: Array<{ id: string; fields: Array<{ field: string; ours: string; theirs: string }> }>;
  };
  const c1 = listed.data[0];
  ok(
    "flag: a conflict is recorded with the field-level diff",
    listed.data.length === 1 &&
      /^hscf_/.test(c1?.id ?? "") &&
      c1!.fields.some(
        (f) => f.field === "first_name" && f.ours === "LocalC" && f.theirs === "RemoteC",
      ),
  );
  ok(
    "flag: neither side is overwritten while it is open",
    (await customerRow(a.id)).firstName === "LocalC" &&
      store.contacts.get(contactId!)!.firstname === "RemoteC",
  );
  await local(a.publicId, { phone: "+1 555 0400" });
  edit("contacts", contactId!, { lastname: "Byron" });
  await pass();
  ok(
    "flag: later changes on either side stay held",
    writes().filter((w) => w.path.includes(`/contacts/${contactId}`)).length === 0 &&
      (await customerRow(a.id)).lastName === "Lovelace",
  );
  const kept = await api("POST", `/conflicts/${c1!.id}/resolve`, { keep: "ours" });
  r = await pass();
  ok("resolve keep ours is accepted", kept.statusCode === 200);
  ok(
    "resolve keep ours: our values are pushed and the hold is released",
    store.contacts.get(contactId!)!.firstname === "LocalC" &&
      store.contacts.get(contactId!)!.phone === "+1 555 0400",
  );
  ok(
    "resolving twice is refused",
    (await api("POST", `/conflicts/${c1!.id}/resolve`, { keep: "theirs" })).statusCode === 409,
  );

  await local(a.publicId, { firstName: "LocalD" });
  edit("contacts", contactId!, { firstname: "RemoteD" });
  await pass();
  const c2 = ((await api("GET", "/conflicts")).json() as { data: Array<{ id: string }> }).data[0];
  edit("contacts", contactId!, { firstname: "RemoteD2" });
  const took = await api("POST", `/conflicts/${c2!.id}/resolve`, { keep: "theirs" });
  ca = await customerRow(a.id);
  r = await pass();
  ok(
    "resolve keep theirs: HubSpot's current value is applied",
    took.statusCode === 200 && ca.firstName === "RemoteD2",
  );
  ok(
    "after resolving, the record syncs normally and no new conflict opens",
    ((await api("GET", "/conflicts")).json() as { data: unknown[] }).data.length === 0 &&
      store.contacts.get(contactId!)!.firstname === "RemoteD2",
  );
  ok(
    "an unknown conflict is a 404",
    (await api("POST", "/conflicts/hscf_nope/resolve", { keep: "ours" })).statusCode === 404,
  );

  // ── Shared companies: company edits ignored, contact edits still pulled.
  await setSettings({
    updates: { conflict: "remote_wins" },
    customers: { multipleCustomersPerCompany: true },
  });
  edit("companies", companyId!, { name: "Shared Rename" });
  edit("contacts", contactId!, { firstname: "SharedOK" });
  await pass();
  ca = await customerRow(a.id);
  ok("with shared companies, company changes are not pulled", ca.company === "Analytical Engines");
  ok("with shared companies, contact changes still are", ca.firstName === "SharedOK");

  // ── Paging past HubSpot's 10,000-result cap; unlinked records are ignored.
  const customerCount = async () =>
    (
      await withTenant(orgId, (tx) =>
        tx.select({ id: customers.id }).from(customers).where(eq(customers.businessId, biz.id)),
      )
    ).length;
  const countBefore = await customerCount();
  for (let i = 0; i < 10_120; i++)
    seed("contacts", { email: `stranger${i}@x-${RUN}.test`, firstname: "Stranger" });
  edit("contacts", contactId!, { firstname: "PastCap" });
  await pass();
  const pages = searches("contacts");
  const restarted = pages.filter((h) => h.body.after === undefined).length;
  ok("a pass pages through the results 100 at a time", pages.length > 100);
  ok(
    "past the 10,000 cap it restarts from the newest record and reaches the rest",
    restarted >= 2 && (await customerRow(a.id)).firstName === "PastCap",
  );
  ok("unlinked records are ignored", (await customerCount()) === countBefore);
  const wm = (await getConnection(orgId, biz.id))!.contactsWatermark!;
  const newest = updated.get(`contacts:${contactId}`)!;
  ok(
    "the watermark only moves forward and trails the newest record by the overlap window",
    wm.getTime() >= offMark && wm.getTime() >= newest - 120_000 && wm.getTime() < newest,
  );
  r = await pass();
  ok(
    "a record re-read inside the overlap is not applied twice",
    !r.items.some((i) => i.remoteId === contactId),
  );

  // ── An edit made after our push is pulled on first sighting.
  const b = await createCustomer({ ...scope, email: `bea@b-${RUN}.test`, firstName: "Bea" });
  await pass("event");
  const bContact = (await linkOf(b.id, "contact")).remoteId;
  skew = 90_000;
  edit("contacts", bContact, { firstname: "Beatrice" });
  await pass();
  ok(
    "an edit made after our push is pulled on first sighting",
    (await customerRow(b.id)).firstName === "Beatrice",
  );

  // ── RLS on the conflicts table.
  const other = await createOrganization({ name: `HS Inbound other ${RUN}` });
  const leaked = await withTenant(other.organization.id, (tx) =>
    tx.select().from(hubspotConflicts),
  );
  const ownRows = await withTenant(orgId, (tx) => tx.select().from(hubspotConflicts));
  let crossWrite = false;
  try {
    await withTenant(other.organization.id, (tx) =>
      tx.insert(hubspotConflicts).values({
        organizationId: orgId,
        businessId: biz.id,
        connectionId: conn.id,
        publicId: `hscf_x${RUN}`,
        localType: "customer",
        localId: a.id,
        remoteType: "company",
        remoteId: "1",
      }),
    );
    crossWrite = true;
  } catch {}
  ok(
    "RLS: conflicts are invisible and unwritable across tenants",
    leaked.length === 0 && ownRows.length >= 2 && !crossWrite,
  );

  await app.close();
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
console.log(failed ? "❌ HUBSPOT-INBOUND: FAIL" : "✅ HUBSPOT-INBOUND: PASS");
process.exit(failed ? 1 : 0);
