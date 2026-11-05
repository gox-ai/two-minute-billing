/**
 * HubSpot sync: invoices → the portal's invoice custom object, against a local stand-in for
 * HubSpot. No request leaves this process.
 *
 * What regresses without this:
 *  1. a finalized invoice is not created, or carries the wrong number, status, money or dates.
 *  2. a payment, part-payment, void, write-off or credit note does not update the record.
 *  3. a lost link (or a retry after a create) duplicates the record instead of matching on invoice_id.
 *  4. the record is not associated to the contact, company and deal.
 *  5. drafts sync; invoices queue while invoice sync is off; enabling it without an object is accepted.
 *  6. a grant without the custom-object scopes fails and retries instead of skipping once.
 *  7. the requested optional scopes drift from the HubSpot app's.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-invoices
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Pinned, not inherited from .env: config is read at import, and a real secret must never be sent to the stand-in.
process.env.HUBSPOT_CLIENT_ID = "verify-client-id";
process.env.HUBSPOT_CLIENT_SECRET = "verify-client-secret";
process.env.HUBSPOT_REDIRECT_URI = "http://localhost:4100/integrations/hubspot/callback";
process.env.PORTAL_BASE_URL = "https://billing.example.com";

const { and, eq } = await import("drizzle-orm");
const { closeDb, withTenant } = await import("@/platform/db");
const { createOrganization, createBusiness } = await import("@/modules/tenancy/service");
const { createCustomer } = await import("@/modules/customers/service");
const { createProduct, createPrice } = await import("@/modules/catalog/service");
const { createSubscription } = await import("@/modules/subscriptions/service");
const { createManualInvoice, voidInvoice, writeOffInvoice, recordOfflinePayment } =
  await import("@/modules/invoicing/ops");
const { issueAdjustmentCreditNote } = await import("@/modules/credit-notes/service");
const { createInvoiceFromLines } = await import("@/modules/invoicing/service");
await import("@/modules/integrations/sink");
const { REQUIRED_SCOPES, OPTIONAL_SCOPES, INVOICE_SCOPES } =
  await import("@/modules/hubspot/oauth");
const { connectHubSpot, getConnection, updateConnection, HubSpotConnectionError } =
  await import("@/modules/hubspot/connections");
const { runSync } = await import("@/modules/hubspot/sync/engine");
const { INVOICE_PROPERTIES } = await import("@/modules/hubspot/settings");
const { hubspotConnections, hubspotLinks, hubspotSyncItems, hubspotSyncQueue, invoices } =
  await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);
const OBJ = "2-424242";

type Hit = { method: string; path: string; body: Record<string, unknown> };
const hits: Hit[] = [];
let nextId = 9000;
type Obj = "contacts" | "companies" | "deals" | typeof OBJ;
const store: Record<string, Map<string, Record<string, string>>> = {
  contacts: new Map(),
  companies: new Map(),
  deals: new Map(),
  [OBJ]: new Map(),
};
const associations: string[] = [];
const grantScopes: string[] = [...REQUIRED_SCOPES, ...INVOICE_SCOPES];
/** The custom object's properties; `issue_date`/`due_date` are HubSpot `date` properties. */
let objectProps: Array<{ name: string; type: string }> = INVOICE_PROPERTIES.map((name) => ({
  name,
  type: name.endsWith("_date")
    ? "date"
    : ["total", "amount_due", "amount_paid"].includes(name)
      ? "number"
      : "string",
}));

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const method = req.method ?? "GET";
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://stub").pathname);
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
        hub_id: 737373,
        hub_domain: "invoices.hubspot.test",
        user: "ops@verify.test",
        scopes: grantScopes,
      });
    if (method === "GET" && path === `/crm/v3/properties/${OBJ}`)
      return send(200, { results: objectProps });
    if (method === "GET" && path.startsWith("/crm/v3/properties/"))
      return send(200, { results: [] });

    const assoc = /^\/crm\/v4\/objects\/([\w-]+)\/(\d+)\/associations\/default\/(\w+)\/(\d+)$/.exec(
      path,
    );
    if (method === "PUT" && assoc) {
      associations.push(`${assoc[1]}:${assoc[2]}->${assoc[3]}:${assoc[4]}`);
      return send(200, { status: "COMPLETE" });
    }
    if (method === "GET" && /^\/crm\/v4\/objects\/contacts\/\d+\/associations\/deals$/.test(path))
      return send(200, { results: [] });

    const search = /^\/crm\/v3\/objects\/([\w-]+)\/search$/.exec(path);
    if (method === "POST" && search) {
      const f = (
        body.filterGroups as Array<{ filters: Array<{ propertyName: string; value: string }> }>
      )[0]!.filters[0]!;
      for (const [id, p] of store[search[1] as Obj] ?? []) {
        if ((p[f.propertyName] ?? "").toLowerCase() === f.value.toLowerCase())
          return send(200, { total: 1, results: [{ id, properties: p }] });
      }
      return send(200, { total: 0, results: [] });
    }
    const create = /^\/crm\/v3\/objects\/([\w-]+)$/.exec(path);
    if (method === "POST" && create && store[create[1]!]) {
      const p = (body.properties ?? {}) as Record<string, string>;
      if (create[1] === "contacts") {
        const dup = [...store.contacts!].find(([, c]) => c.email === p.email);
        if (dup) return send(409, { message: `Object already exists. Existing ID: ${dup[0]}` });
      }
      const id = String(nextId++);
      store[create[1]!]!.set(id, { ...p });
      return send(201, { id });
    }
    const one = /^\/crm\/v3\/objects\/([\w-]+)\/(\d+)$/.exec(path);
    if (one && store[one[1]!]) {
      const rec = store[one[1]!]!.get(one[2]!);
      if (!rec) return send(404, { message: "resource not found" });
      if (method === "PATCH") {
        Object.assign(rec, (body.properties ?? {}) as Record<string, string>);
        return send(200, { id: one[2] });
      }
      if (method === "GET") return send(200, { id: one[2], properties: rec });
    }
    send(404, { message: `unexpected ${method} ${path}` });
  });
});

const records = () => store[OBJ]!;
const objCalls = () => hits.filter((h) => h.path.startsWith(`/crm/v3/objects/${OBJ}`));
const objPosts = () =>
  hits.filter((h) => h.method === "POST" && h.path === `/crm/v3/objects/${OBJ}`);
const recordOf = (publicId: string) =>
  [...records()].find(([, p]) => p.invoice_id === publicId) ?? null;
const utcMidnight = (d: Date) =>
  String(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 7. Optional scopes match the app's.
  const app = JSON.parse(readFileSync("hubspot-app/src/app/app-hsmeta.json", "utf8"));
  const appOptional: string[] = app.config.auth.optionalScopes;
  ok(
    "requested optional scopes equal hubspot-app optionalScopes, custom objects included",
    appOptional.length === OPTIONAL_SCOPES.length &&
      OPTIONAL_SCOPES.every((s) => appOptional.includes(s)) &&
      INVOICE_SCOPES.every((s) => appOptional.includes(s)),
  );

  const org = await createOrganization({ name: `HS Invoices ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "HS Invoices Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const scope = { organizationId: orgId, businessId: biz.id };
  await connectHubSpot({ ...scope, code: "good-code", apiBase });
  let conn = (await getConnection(orgId, biz.id))!;
  await withTenant(orgId, (tx) =>
    tx
      .update(hubspotConnections)
      .set({ initialSync: "done" })
      .where(eq(hubspotConnections.id, conn.id)),
  );
  const setSettings = async (patch: Record<string, unknown>) => {
    await updateConnection(orgId, biz.id, { settings: patch });
    conn = (await getConnection(orgId, biz.id))!;
  };
  await setSettings({ products: { enabled: false } });

  const sync = async () => {
    hits.length = 0;
    associations.length = 0;
    const r = await runSync(conn, "event");
    const items = r.run
      ? await withTenant(orgId, (tx) =>
          tx.select().from(hubspotSyncItems).where(eq(hubspotSyncItems.runId, r.run!.id)),
        )
      : [];
    return { ...r, items };
  };
  const queued = async (type: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(hubspotSyncQueue)
        .where(
          and(eq(hubspotSyncQueue.connectionId, conn.id), eq(hubspotSyncQueue.resourceType, type)),
        ),
    );
  const line = (description: string, amt: number) => ({
    description,
    amountMinor: BigInt(amt),
    kind: "one_time",
  });
  const customer = await createCustomer({
    ...scope,
    email: `buyer@acme-${RUN}.test`,
    company: "Acme",
  });
  const invoice = (amt: number) =>
    createManualInvoice({
      ...scope,
      customerId: customer.id,
      currency: "USD",
      lines: [line("Consulting", amt)],
      netDays: 30,
    }).then((r) => r.invoice);

  // 5. Off by default: an invoice event queues no invoice row.
  await invoice(1000);
  ok("invoice sync is off by default and queues nothing", (await queued("invoice")).length === 0);
  await sync();

  let refused = false;
  try {
    await updateConnection(orgId, biz.id, { settings: { invoices: { enabled: true } } });
  } catch (e) {
    refused =
      e instanceof HubSpotConnectionError && /No HubSpot object is selected/.test(e.message);
  }
  ok("enabling invoice sync without an object is refused", refused);
  await setSettings({ invoices: { enabled: true, objectType: OBJ } });

  // 1 + 4. Finalized invoice → record, associated to contact and company.
  const inv1 = await invoice(5000);
  let r = await sync();
  const [rid1, p1] = recordOf(inv1.publicId) ?? [null, {} as Record<string, string>];
  ok(
    "a finalized invoice creates one record with number, status, currency and money",
    objPosts().length === 1 &&
      !!rid1 &&
      p1.invoice_number === (inv1.number ?? "") &&
      p1.invoice_status === inv1.status &&
      p1.currency === "USD" &&
      p1.total === "50.00" &&
      p1.amount_due === "50.00" &&
      p1.amount_paid === "0.00",
  );
  ok(
    "issue and due dates go to date properties as UTC midnight",
    p1.issue_date === utcMidnight(inv1.finalizedAt ?? inv1.createdAt) &&
      p1.due_date === utcMidnight(inv1.dueDate!),
  );
  ok(
    "the link is the buyer portal, never an operator screen",
    p1.invoice_url === "https://billing.example.com/portal?tab=invoices",
  );
  const contactId = [...store.contacts!].find(([, c]) => c.email === customer.email)?.[0];
  const companyId = [...store.companies!.keys()][0];
  ok(
    "the record is associated to the customer's contact and company",
    !!contactId &&
      associations.includes(`${OBJ}:${rid1}->contacts:${contactId}`) &&
      associations.includes(`${OBJ}:${rid1}->companies:${companyId}`) &&
      r.items.some((i) => i.localType === "invoice" && i.action === "created"),
  );

  // Unchanged → no object call.
  await withTenant(orgId, (tx) =>
    tx.insert(hubspotSyncQueue).values({
      organizationId: orgId,
      businessId: biz.id,
      connectionId: conn.id,
      resourceType: "invoice",
      resourceId: inv1.id,
    }),
  );
  r = await sync();
  ok("an unchanged invoice costs no object call", objCalls().length === 0 && r.skipped >= 1);

  // 2. Part-payment, then full payment.
  await recordOfflinePayment({
    ...scope,
    invoicePublicId: inv1.publicId,
    amountMinor: 2000,
    method: "wire",
  });
  r = await sync();
  ok(
    "a part-payment updates amount paid and amount due on the same record",
    objPosts().length === 0 &&
      records().get(rid1!)?.amount_paid === "20.00" &&
      records().get(rid1!)?.amount_due === "30.00",
  );
  await recordOfflinePayment({ ...scope, invoicePublicId: inv1.publicId, method: "wire" });
  r = await sync();
  ok(
    "paying the rest marks the record paid with nothing due",
    records().get(rid1!)?.invoice_status === "paid" &&
      records().get(rid1!)?.amount_due === "0.00" &&
      records().get(rid1!)?.amount_paid === "50.00",
  );

  const inv2 = await invoice(4000);
  await sync();
  await voidInvoice(orgId, biz.id, inv2.publicId);
  await sync();
  ok(
    "a void updates the record to voided",
    recordOf(inv2.publicId)?.[1].invoice_status === "voided",
  );

  const inv3 = await invoice(6000);
  await sync();
  await writeOffInvoice(orgId, biz.id, inv3.publicId);
  await sync();
  ok(
    "a write-off updates the record to written_off with nothing due or paid",
    recordOf(inv3.publicId)?.[1].invoice_status === "written_off" &&
      recordOf(inv3.publicId)?.[1].amount_due === "0.00" &&
      recordOf(inv3.publicId)?.[1].amount_paid === "0.00",
  );

  const inv4 = await invoice(8000);
  await sync();
  await issueAdjustmentCreditNote({
    ...scope,
    invoicePublicId: inv4.publicId,
    items: [{ description: "Goodwill", amountMinor: 3000 }],
  });
  r = await sync();
  ok(
    "a credit note lowers the record's amount due",
    recordOf(inv4.publicId)?.[1].amount_due === "50.00",
  );

  // 3. Lost link: the next push matches on invoice_id instead of creating a second record.
  await withTenant(orgId, (tx) =>
    tx
      .delete(hubspotLinks)
      .where(and(eq(hubspotLinks.localType, "invoice"), eq(hubspotLinks.localId, inv4.id))),
  );
  await recordOfflinePayment({ ...scope, invoicePublicId: inv4.publicId, method: "wire" });
  r = await sync();
  const inv4Records = [...records().values()].filter((p) => p.invoice_id === inv4.publicId);
  ok(
    "a lost link matches the record on invoice_id: no duplicate",
    objPosts().length === 0 &&
      inv4Records.length === 1 &&
      inv4Records[0]!.invoice_status === "paid" &&
      r.items.some((i) => /matched on invoice_id/.test(i.message ?? "")),
  );

  // 4. A subscription invoice is associated to its deal.
  const product = await createProduct({ ...scope, name: "Growth" });
  const price = await createPrice({
    ...scope,
    productId: product.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const sub = await createSubscription({
    ...scope,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const subId = sub.subscription.id;
  await sync();
  const { invoice: subInv } = await createInvoiceFromLines({
    ...scope,
    customerId: customer.id,
    subscriptionId: subId,
    currency: "USD",
    lines: [line("Extra seats", 2500)],
  });
  await sync();
  const dealId = [...store.deals!.keys()][0];
  const subRec = subInv ? recordOf(subInv.publicId) : null;
  ok(
    "a subscription invoice is associated to the subscription's deal",
    !!subInv &&
      !!dealId &&
      !!subRec &&
      hits.some(
        (h) =>
          h.method === "PUT" &&
          h.path === `/crm/v4/objects/${OBJ}/${subRec[0]}/associations/default/deals/${dealId}`,
      ),
  );

  // 5. Full sweep queues finalized invoices only.
  const all = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.businessId, biz.id)),
  );
  // A spent budget queues the book and stops before pushing it.
  await runSync(conn, "event", { full: true, budgetMs: 0 });
  const swept = new Set((await queued("invoice")).map((q) => q.resourceId));
  const finalized = all.filter((i) => i.status !== "pending");
  ok(
    "the full sweep queues every finalized invoice and no draft",
    finalized.length > 0 &&
      swept.size === finalized.length &&
      finalized.every((i) => swept.has(i.id)),
  );
  await withTenant(orgId, (tx) =>
    tx.delete(hubspotSyncQueue).where(eq(hubspotSyncQueue.connectionId, conn.id)),
  );

  // Object missing optional properties: pushed without them, and the log says which.
  objectProps = objectProps.filter((p) => p.name !== "invoice_url");
  const inv5 = await invoice(1500);
  r = await sync();
  ok(
    "a property the object lacks is left out and named in the log",
    !!recordOf(inv5.publicId) &&
      !("invoice_url" in recordOf(inv5.publicId)![1]) &&
      r.items.some((i) => /Left out invoice_url/.test(i.message ?? "")),
  );
  objectProps = objectProps.filter((p) => p.name !== "invoice_id");
  const inv6 = await invoice(1600);
  r = await sync();
  ok(
    "an object without invoice_id is skipped with the reason",
    !recordOf(inv6.publicId) &&
      r.items.some(
        (i) => i.action === "skipped" && /no writable "invoice_id"/.test(i.message ?? ""),
      ),
  );

  // 6. A grant without the custom-object scopes skips once, with the fix, and does not retry.
  await withTenant(orgId, (tx) =>
    tx
      .update(hubspotConnections)
      .set({ scopes: [...REQUIRED_SCOPES] })
      .where(eq(hubspotConnections.id, conn.id)),
  );
  conn = (await getConnection(orgId, biz.id))!;
  const inv7 = await invoice(1700);
  r = await sync();
  ok(
    "missing custom-object scopes: skipped with a reconnect message, no object call, no retry",
    objCalls().length === 0 &&
      r.failed === 0 &&
      r.items.some(
        (i) =>
          i.localRef === inv7.publicId &&
          i.action === "skipped" &&
          /Connect HubSpot again/.test(i.message ?? ""),
      ) &&
      (await queued("invoice")).length === 0,
  );

  // Sync off again → no invoice rows queued.
  await setSettings({ invoices: { enabled: false } });
  await invoice(1800);
  ok("invoice sync off queues no invoice rows", (await queued("invoice")).length === 0);
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
console.log(failed ? "❌ HUBSPOT-INVOICES: FAIL" : "✅ HUBSPOT-INVOICES: PASS");
process.exit(failed ? 1 : 0);
