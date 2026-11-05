/**
 * HubSpot sync, phase 2: customers → contacts and companies — against a local stand-in for
 * HubSpot. No request leaves this process.
 *
 * What regresses without this:
 *  1. a contact is matched on the wrong property (or case-sensitively), or a match on a custom field is ignored.
 *  2. companies are not created, not matched on domain/name, or not associated to the contact.
 *  3. one customer takes over a company another customer holds while sharing is off.
 *  4. "don't create missing records" still creates them.
 *  5. linking to an existing record overwrites it when told to fill blanks or only link.
 *  6. a linked record is overwritten while updates to HubSpot are off.
 *  7. customers without a live subscription sync under the active-subscriptions scope.
 *  8. the billing address lands in standard properties when it is routed to custom fields.
 *  9. mapped fields send minor units, wrong booleans, non-midnight dates, or `to_local` mappings.
 * 10. a terminal company error costs the contact its link; a 409 on create is not treated as a match.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-customers
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
const { toHubSpot } = await import("@/modules/hubspot/sync/fields");
const { hubspotLinks, hubspotSyncItems, invoices, subscriptions } = await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);

type Hit = { method: string; path: string; body: Record<string, unknown> };
const hits: Hit[] = [];
/** Scripted answers, consumed in order; `match` is a "METHOD path" prefix, or the whole of it when `exact`. */
const UNIQUE_CONTACT_PROP = "unique_ref";
const script: Array<{ match: string; exact?: boolean; status: number; body?: unknown }> = [];
let nextId = 5000;
const store = {
  contacts: new Map<string, Record<string, string>>(),
  companies: new Map<string, Record<string, string>>(),
};
const associations: string[] = [];
const PROPERTY_TYPES: Record<string, string> = {
  since_prop: "datetime",
  since_date_prop: "date",
  renewal_prop: "date",
};

function seed(object: "contacts" | "companies", props: Record<string, string>): string {
  const id = String(nextId++);
  store[object].set(id, { ...props });
  return id;
}

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

    const i = script.findIndex((s) =>
      s.exact ? `${method} ${path}` === s.match : `${method} ${path}`.startsWith(s.match),
    );
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

    const props = /^\/crm\/v3\/properties\/(contacts|companies)$/.exec(path);
    if (method === "GET" && props)
      return send(200, {
        results: Object.entries(PROPERTY_TYPES).map(([name, type]) => ({
          name,
          label: name,
          type,
        })),
      });

    const assoc =
      /^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/default\/companies\/(\d+)$/.exec(path);
    if (method === "PUT" && assoc) {
      associations.push(`${assoc[1]}->${assoc[2]}`);
      return send(200, { status: "COMPLETE" });
    }

    const search = /^\/crm\/v3\/objects\/(contacts|companies)\/search$/.exec(path);
    if (method === "POST" && search) {
      const f = (
        body.filterGroups as Array<{ filters: Array<{ propertyName: string; value: string }> }>
      )[0]!.filters[0]!;
      const want = (body.properties as string[]) ?? [];
      for (const [id, p] of store[search[1] as "contacts"]) {
        if ((p[f.propertyName] ?? "").toLowerCase() === f.value.toLowerCase())
          return send(200, {
            total: 1,
            results: [{ id, properties: Object.fromEntries(want.map((k) => [k, p[k] ?? null])) }],
          });
      }
      return send(200, { total: 0, results: [] });
    }

    // A unique contact property: a value another contact holds is refused, as HubSpot does.
    const target = /^\/crm\/v3\/objects\/contacts(?:\/(\d+))?$/.exec(path);
    if ((method === "POST" || method === "PATCH") && target) {
      const p = (body.properties ?? {}) as Record<string, string>;
      const v = p[UNIQUE_CONTACT_PROP];
      const holder = v
        ? [...store.contacts].find(([id, c]) => id !== target[1] && c[UNIQUE_CONTACT_PROP] === v)
        : undefined;
      if (holder)
        return send(400, {
          status: "error",
          category: "VALIDATION_ERROR",
          message: `Cannot set PropertyValueCoordinates{portalId=525252, objectTypeId=ObjectTypeId{legacyObjectType=CONTACT}, propertyName=${UNIQUE_CONTACT_PROP}, value=${v}} on ${target[1] ?? "new"}. ${holder[0]} already has that value.`,
        });
    }

    const create = /^\/crm\/v3\/objects\/(contacts|companies)$/.exec(path);
    if (method === "POST" && create) {
      const object = create[1] as "contacts";
      const p = (body.properties ?? {}) as Record<string, string>;
      if (object === "contacts" && p.email) {
        const dup = [...store.contacts].find(([, c]) => c.email === p.email);
        if (dup) return send(409, { message: `Contact already exists. Existing ID: ${dup[0]}` });
      }
      return send(201, { id: seed(object, p) });
    }

    const one = /^\/crm\/v3\/objects\/(contacts|companies)\/(\d+)$/.exec(path);
    if (one) {
      const rec = store[one[1] as "contacts"].get(one[2]!);
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

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await createOrganization({ name: `HS Customers ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "HS Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await connectHubSpot({ organizationId: orgId, businessId: biz.id, code: "good-code", apiBase });
  let conn = (await getConnection(orgId, biz.id))!;

  const setSettings = async (patch: Record<string, unknown>) => {
    await updateConnection(orgId, biz.id, { settings: patch });
    conn = (await getConnection(orgId, biz.id))!;
  };
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
  const links = (customerId: string) =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(hubspotLinks)
        .where(and(eq(hubspotLinks.localType, "customer"), eq(hubspotLinks.localId, customerId))),
    );
  const linkOf = async (customerId: string, type: string) =>
    (await links(customerId)).find((l) => l.remoteType === type);
  const posted = (object: string) =>
    hits.filter((h) => h.method === "POST" && h.path === `/crm/v3/objects/${object}`);
  const patches = (object: string, id?: string) =>
    hits.filter(
      (h) => h.method === "PATCH" && h.path.startsWith(`/crm/v3/objects/${object}/${id ?? ""}`),
    );
  const propsOf = (h: Hit | undefined) => (h?.body.properties ?? {}) as Record<string, string>;
  let n = 0;
  const customer = (
    fields: Omit<Parameters<typeof createCustomer>[0], "organizationId" | "businessId">,
  ) => createCustomer({ organizationId: orgId, businessId: biz.id, ...fields });
  const domain = () => `d${++n}-${RUN}.test`;

  // ── Defaults: match on email, company on the email's domain, create what is missing.
  const acme = domain();
  const c1 = await customer({
    email: `Ada@${acme.toUpperCase()}`,
    firstName: "Ada",
    lastName: "Lovelace",
    company: "Acme",
    phone: "+1 555 0100",
    address: {
      line1: "1 Main St",
      line2: "Suite 4",
      city: "Springfield",
      state: "IL",
      postalCode: "62701",
      country: "US",
    },
  });
  let r = await sync();
  const cSearch = hits.find((h) => h.path === "/crm/v3/objects/contacts/search");
  const filter = (
    cSearch?.body.filterGroups as Array<{ filters: Array<Record<string, string>> }>
  )?.[0]?.filters[0];
  ok(
    "contact search is an EQ filter on the lowercased email, limit 1",
    filter?.propertyName === "email" &&
      filter.operator === "EQ" &&
      filter.value === `ada@${acme}` &&
      cSearch?.body.limit === 1,
  );
  const madeContact = propsOf(posted("contacts")[0]);
  ok(
    "a new contact gets the standard properties and the billing address",
    madeContact.email === `ada@${acme}` &&
      madeContact.firstname === "Ada" &&
      madeContact.lastname === "Lovelace" &&
      madeContact.phone === "+1 555 0100" &&
      madeContact.company === "Acme" &&
      madeContact.address === "1 Main St, Suite 4" &&
      madeContact.city === "Springfield" &&
      madeContact.state === "IL" &&
      madeContact.zip === "62701" &&
      madeContact.country === "US",
  );
  const coSearch = hits.find((h) => h.path === "/crm/v3/objects/companies/search");
  const coFilter = (
    coSearch?.body.filterGroups as Array<{ filters: Array<Record<string, string>> }>
  )?.[0]?.filters[0];
  const madeCompany = propsOf(posted("companies")[0]);
  ok(
    "the company is matched on the email's domain",
    coFilter?.propertyName === "domain" && coFilter.value === acme,
  );
  ok(
    "a new company gets name, domain and the billing address",
    madeCompany.name === "Acme" &&
      madeCompany.domain === acme &&
      madeCompany.address === "1 Main St" &&
      madeCompany.address2 === "Suite 4" &&
      madeCompany.city === "Springfield",
  );
  const c1Contact = await linkOf(c1.id, "contact");
  const c1Company = await linkOf(c1.id, "company");
  ok("contact and company are both linked", !!c1Contact && !!c1Company);
  ok(
    "the contact is associated with the company (v4 default)",
    associations.includes(`${c1Contact?.remoteId}->${c1Company?.remoteId}`),
  );
  ok(
    "one outcome per object touched",
    r.created === 2 &&
      r.items.some((i) => i.remoteType === "contact" && i.action === "created") &&
      r.items.some((i) => i.remoteType === "company" && i.action === "created"),
  );

  // Unchanged → no call, no re-association.
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c1.publicId,
    // A no-op edit emits nothing, so touch a field HubSpot does not sync to queue the record.
    invoiceNotes: "queued, nothing synced changed",
  });
  r = await sync();
  ok(
    "an unchanged customer costs no API call",
    hits.every((h) => !h.path.startsWith("/crm/")) && r.skipped === 2,
  );

  // Changed → PATCH both.
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c1.publicId,
    company: "Acme Corp",
  });
  r = await sync();
  ok(
    "a change PATCHes the linked contact and company",
    patches("contacts", c1Contact!.remoteId).length === 1 &&
      propsOf(patches("companies", c1Company!.remoteId)[0]).name === "Acme Corp" &&
      associations.length === 0,
  );

  // ── Sharing off: a company held by another customer is not taken over.
  const c2 = await customer({ email: `grace@${acme}`, firstName: "Grace" });
  r = await sync();
  const taken = r.items.find((i) => i.remoteType === "company");
  ok(
    "a company linked to another customer is skipped while sharing is off",
    taken?.action === "skipped" &&
      /already linked to/.test(taken.message ?? "") &&
      /Let several customers share one company/.test(taken.message ?? "") &&
      !(await linkOf(c2.id, "company")) &&
      !!(await linkOf(c2.id, "contact")) &&
      associations.length === 0,
  );

  // ── fill_empty (the default) on an existing contact.
  const fillDomain = domain();
  const existing = seed("contacts", {
    email: `kim@${fillDomain}`,
    firstname: "Kimberly",
    lastname: "",
  });
  await customer({
    email: `kim@${fillDomain}`,
    firstName: "Kim",
    lastName: "Lee",
    phone: "+44 20 7946 0000",
  });
  r = await sync();
  const fill = propsOf(patches("contacts", existing)[0]);
  ok(
    "fill_empty writes only the properties HubSpot has blank",
    fill.lastname === "Lee" &&
      fill.phone === "+44 20 7946 0000" &&
      !("firstname" in fill) &&
      store.contacts.get(existing)!.firstname === "Kimberly" &&
      r.items.some(
        (i) => i.remoteId === existing && i.action === "updated" && /Filled/.test(i.message ?? ""),
      ),
  );

  // ── overwrite.
  await setSettings({ customers: { onMatch: "overwrite" } });
  const owDomain = domain();
  const owContact = seed("contacts", { email: `ow@${owDomain}`, firstname: "Old" });
  await customer({ email: `ow@${owDomain}`, firstName: "New" });
  await sync();
  ok(
    "overwrite writes every property to a matched record",
    propsOf(patches("contacts", owContact)[0]).firstname === "New",
  );

  // ── link_only.
  await setSettings({ customers: { onMatch: "link_only" } });
  const loDomain = domain();
  const loContact = seed("contacts", { email: `lo@${loDomain}`, firstname: "Untouched" });
  const lo = await customer({ email: `lo@${loDomain}`, firstName: "Ignored" });
  r = await sync();
  ok(
    "link_only links a matched record without writing to it",
    patches("contacts", loContact).length === 0 &&
      (await linkOf(lo.id, "contact"))?.remoteId === loContact &&
      store.contacts.get(loContact)!.firstname === "Untouched",
  );
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: lo.publicId,
    firstName: "Later",
  });
  await sync();
  ok(
    "after linking, a later change pushes normally",
    propsOf(patches("contacts", loContact)[0]).firstname === "Later",
  );
  await setSettings({ customers: { onMatch: "fill_empty" } });

  // ── createMissing off.
  await setSettings({ customers: { createMissing: false } });
  const nmDomain = domain();
  const nm = await customer({ email: `nomatch@${nmDomain}` });
  r = await sync();
  ok(
    "with creating off, an unmatched customer is skipped and nothing is created",
    posted("contacts").length === 0 &&
      posted("companies").length === 0 &&
      !(await linkOf(nm.id, "contact")) &&
      r.items.filter(
        (i) => i.action === "skipped" && /creating missing records is off/.test(i.message ?? ""),
      ).length === 2,
  );
  const mDomain = domain();
  const mContact = seed("contacts", { email: `match@${mDomain}` });
  const mm = await customer({ email: `match@${mDomain}` });
  await sync();
  ok(
    "with creating off, a matched customer still links",
    (await linkOf(mm.id, "contact"))?.remoteId === mContact,
  );
  await setSettings({ customers: { createMissing: true } });

  // ── Match on a custom field, and a company on its name.
  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "customer",
    apiName: "crm_id",
    label: "CRM id",
    dataType: "string",
  });
  await setSettings({
    customers: {
      contactMatch: { local: "cf_crm_id", remote: "crm_ref" },
      companyMatch: { local: "company", remote: "name" },
    },
  });
  const cfContact = seed("contacts", { email: `someone-else@${domain()}`, crm_ref: `X-${RUN}` });
  const globex = seed("companies", { name: `Globex ${RUN}` });
  const cf = await customer({
    email: `cf@${domain()}`,
    company: `Globex ${RUN}`,
    customFields: { crm_id: `X-${RUN}` },
  });
  await sync();
  const cfSearch = hits.find((h) => h.path === "/crm/v3/objects/contacts/search");
  ok(
    "a contact matches on a custom field against the chosen property",
    (
      cfSearch?.body.filterGroups as Array<{ filters: Array<Record<string, string>> }> | undefined
    )?.[0]?.filters[0]?.propertyName === "crm_ref" &&
      (await linkOf(cf.id, "contact"))?.remoteId === cfContact,
  );
  ok(
    "a company matches on the customer's company name",
    (await linkOf(cf.id, "company"))?.remoteId === globex,
  );
  await setSettings({
    customers: { contactMatch: { local: "email", remote: "email" }, companyMatch: null },
  });

  // ── Company sync off.
  const solo = await customer({ email: `solo@${domain()}`, company: "Solo" });
  r = await sync();
  ok(
    "with company matching off, only the contact is touched",
    !hits.some((h) => h.path.includes("companies")) &&
      r.items.length === 1 &&
      !(await linkOf(solo.id, "company")),
  );
  // ── A duplicate in a unique HubSpot property drops that property, not the record.
  await setSettings({
    customers: {
      companyMatch: null,
      contactFields: [{ remote: UNIQUE_CONTACT_PROP, local: "cf_crm_id", direction: "to_remote" }],
    },
  });
  seed("contacts", { email: `holder-${RUN}@x.test`, [UNIQUE_CONTACT_PROP]: `DUP-${RUN}` });
  const dupe = await customer({
    email: `dupe-${RUN}@x.test`,
    firstName: "Dupe",
    customFields: { crm_id: `DUP-${RUN}` },
  });
  r = await sync();
  const dupeLink = await linkOf(dupe.id, "contact");
  const dupeItem = r.items.find((i) => i.localRef === dupe.publicId && i.remoteType === "contact");
  ok(
    "a value another record holds in a unique property is left out; the contact still syncs and links",
    !!dupeLink &&
      store.contacts.get(dupeLink.remoteId)?.firstname === "Dupe" &&
      store.contacts.get(dupeLink.remoteId)?.[UNIQUE_CONTACT_PROP] === undefined &&
      dupeItem?.action === "created" &&
      /Left out unique_ref/.test(dupeItem?.message ?? ""),
  );
  await setSettings({ customers: { contactFields: [] } });

  // ── Company matched on the whole email address (a property holding one customer's email).
  await setSettings({
    customers: { companyMatch: { local: "email_address", remote: "cb_customer_email" } },
  });
  const heldEmail = `held-${RUN}@gmail.test`;
  const heldCo = seed("companies", { name: `Held ${RUN}`, cb_customer_email: heldEmail });
  const held = await customer({ email: heldEmail.toUpperCase(), company: "Held" });
  const fresh = await customer({ email: `fresh-${RUN}@gmail.test`, company: "Fresh" });
  await sync();
  const emailSearch = hits.find(
    (h) =>
      h.path === "/crm/v3/objects/companies/search" && JSON.stringify(h.body).includes(heldEmail),
  );
  const emailFilter = (
    emailSearch?.body.filterGroups as Array<{ filters: Array<Record<string, string>> }> | undefined
  )?.[0]?.filters[0];
  const freshLink = await linkOf(fresh.id, "company");
  ok(
    "a company matches on the full, lowercased email against the chosen property",
    emailFilter?.propertyName === "cb_customer_email" &&
      emailFilter?.value === heldEmail &&
      (await linkOf(held.id, "company"))?.remoteId === heldCo,
  );
  ok(
    "a company created under that rule carries the email in the matched property",
    !!freshLink &&
      store.companies.get(freshLink.remoteId)?.cb_customer_email === `fresh-${RUN}@gmail.test`,
  );
  await setSettings({ customers: { companyMatch: { local: "email", remote: "domain" } } });

  // ── Updates to HubSpot off, then back on.
  await setSettings({ updates: { localChange: "nothing" } });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c1.publicId,
    firstName: "Countess",
  });
  r = await sync();
  ok(
    "with updates off, a linked customer's change is not pushed",
    patches("contacts").length === 0 &&
      r.items.some(
        (i) => i.action === "skipped" && /Updates to HubSpot are off/.test(i.message ?? ""),
      ),
  );
  await setSettings({ updates: { localChange: "overwrite_remote" } });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c1.publicId,
    phone: "+1 555 0199",
  });
  await sync();
  ok(
    "turning updates back on pushes what was held back",
    propsOf(patches("contacts", c1Contact!.remoteId)[0]).firstname === "Countess",
  );

  // ── A company deleted in HubSpot is re-matched (and re-created).
  store.companies.delete(c1Company!.remoteId);
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c1.publicId,
    company: "Acme Again",
  });
  r = await sync();
  const relinked = await linkOf(c1.id, "company");
  ok(
    "a company deleted in HubSpot is re-created, relinked and re-associated",
    !!relinked &&
      relinked.remoteId !== c1Company!.remoteId &&
      associations.includes(`${c1Contact!.remoteId}->${relinked.remoteId}`),
  );

  // ── 409 on create is a match.
  const lagDomain = domain();
  const lagging = seed("contacts", { email: `lag@${lagDomain}` });
  script.push({
    match: "POST /crm/v3/objects/contacts/search",
    status: 200,
    body: { total: 0, results: [] },
  });
  const lag = await customer({ email: `lag@${lagDomain}` });
  await sync();
  ok(
    "a 409 on create links to the record HubSpot names",
    (await linkOf(lag.id, "contact"))?.remoteId === lagging,
  );

  // ── A terminal company error does not cost the contact its link.
  script.push({
    match: "POST /crm/v3/objects/companies",
    exact: true,
    status: 400,
    body: { message: "Property values were not valid" },
  });
  const bad = await customer({ email: `bad@${domain()}`, company: "Bad" });
  r = await sync();
  ok(
    "a 400 on the company fails the company only; the contact stays linked",
    !!(await linkOf(bad.id, "contact")) &&
      !(await linkOf(bad.id, "company")) &&
      r.items.some(
        (i) =>
          i.remoteType === "company" &&
          i.action === "failed" &&
          i.message === "Property values were not valid",
      ),
  );

  // ── Scope: active subscriptions only.
  await setSettings({ customers: { scope: "active_subscriptions" } });
  const addSub = (customerId: string, status: string, mrr = 0n) =>
    withTenant(orgId, (tx) =>
      tx.insert(subscriptions).values({
        organizationId: orgId,
        businessId: biz.id,
        customerId,
        publicId: `sub_hs_${randomUUID().slice(0, 12)}`,
        status,
        currency: "USD",
        mrr,
      }),
    );
  const noSub = await customer({ email: `nosub@${domain()}` });
  r = await sync();
  ok(
    "a customer with no subscription is skipped under the active scope",
    !(await linkOf(noSub.id, "contact")) &&
      r.items.some((i) => /active subscription/.test(i.message ?? "")),
  );
  await addSub(noSub.id, "paused");
  await addSub(noSub.id, "cancelled");
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: noSub.publicId,
    firstName: "Paused",
  });
  await sync();
  ok(
    "paused and cancelled subscriptions do not count as live",
    !(await linkOf(noSub.id, "contact")),
  );
  await addSub(noSub.id, "future");
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: noSub.publicId,
    firstName: "Future",
  });
  await sync();
  ok("a future subscription counts as live", !!(await linkOf(noSub.id, "contact")));
  await setSettings({ customers: { scope: "all" } });

  // ── Field mappings.
  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "customer",
    apiName: "renewal",
    label: "Renewal",
    dataType: "date",
  });
  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "customer",
    apiName: "vip",
    label: "VIP",
    dataType: "boolean",
  });
  await setSettings({
    customers: {
      contactFields: [
        { remote: "mrr_prop", local: "mrr", direction: "to_remote" },
        { remote: "dues_prop", local: "total_dues", direction: "both" },
        { remote: "since_prop", local: "created_at", direction: "to_remote" },
        { remote: "since_date_prop", local: "created_at", direction: "to_remote" },
        { remote: "renewal_prop", local: "cf_renewal", direction: "to_remote" },
        { remote: "vip_prop", local: "cf_vip", direction: "to_remote" },
        { remote: "autocollect_prop", local: "auto_collection", direction: "to_remote" },
        { remote: "pulled_prop", local: "phone", direction: "to_local" },
      ],
      companyFields: [{ remote: "company_mrr", local: "mrr", direction: "to_remote" }],
    },
  });
  const mapped = await customer({
    email: `mapped@${domain()}`,
    company: "Mapped",
    phone: "+1 555 0142",
    customFields: { renewal: "2027-03-15", vip: true },
  });
  await addSub(mapped.id, "active", 123456n);
  await addSub(mapped.id, "active", 44n);
  await withTenant(orgId, (tx) =>
    tx.insert(invoices).values([
      {
        organizationId: orgId,
        businessId: biz.id,
        customerId: mapped.id,
        publicId: `inv_hs_${RUN}_1`,
        status: "payment_due",
        currency: "USD",
        subtotalMinor: 5000n,
        totalMinor: 5000n,
        amountDueMinor: 5000n,
      },
      {
        organizationId: orgId,
        businessId: biz.id,
        customerId: mapped.id,
        publicId: `inv_hs_${RUN}_2`,
        status: "payment_due",
        currency: "USD",
        subtotalMinor: 9999n,
        totalMinor: 9999n,
        amountDueMinor: 9999n,
        writtenOff: true,
      },
    ]),
  );
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: mapped.publicId,
    firstName: "Mapped",
  });
  await sync();
  const mp = propsOf(posted("contacts")[0]);
  const createdMs = mapped.createdAt.getTime();
  ok("mrr is pushed in major units", mp.mrr_prop === "1235.00");
  ok("total dues are open invoices only, in major units", mp.dues_prop === "50.00");
  ok("a datetime is epoch ms", mp.since_prop === String(createdMs));
  ok(
    "a datetime into a HubSpot date property is pinned to UTC midnight",
    mp.since_date_prop === String(Math.floor(createdMs / 86_400_000) * 86_400_000),
  );
  ok("a date custom field is UTC midnight", mp.renewal_prop === String(Date.UTC(2027, 2, 15)));
  ok('booleans are "true"/"false"', mp.vip_prop === "true" && mp.autocollect_prop === "true");
  ok("to_local mappings are not pushed", !("pulled_prop" in mp));
  ok(
    "company field mappings are pushed to the company",
    propsOf(posted("companies")[0]).company_mrr === "1235.00",
  );
  ok(
    "toHubSpot keeps zero-exponent currencies whole",
    toHubSpot({ kind: "money", minor: 1050n, currency: "JPY" }) === "1050",
  );

  // ── Billing address via custom fields.
  await setSettings({
    customers: {
      billingAddressViaCustomFields: true,
      contactFields: [{ remote: "bill_city", local: "billing_city", direction: "to_remote" }],
      companyFields: [],
    },
  });
  await customer({
    email: `addr@${domain()}`,
    company: "Addr",
    address: { line1: "9 Side St", city: "Shelbyville", country: "US" },
  });
  await sync();
  const ac = propsOf(posted("contacts")[0]);
  const aco = propsOf(posted("companies")[0]);
  ok(
    "with the address routed to custom fields, standard address properties are not written",
    !("address" in ac) &&
      !("city" in ac) &&
      !("country" in ac) &&
      !("address" in aco) &&
      !("city" in aco) &&
      ac.bill_city === "Shelbyville",
  );

  // ── Sharing on: the held company links to a second customer; it cannot be turned off again.
  await setSettings({ customers: { multipleCustomersPerCompany: true } });
  await updateCustomer({
    organizationId: orgId,
    businessId: biz.id,
    customerPublicId: c2.publicId,
    firstName: "Grace H",
  });
  await sync();
  const shared = await linkOf(c2.id, "company");
  const c2Contact = await linkOf(c2.id, "contact");
  ok(
    "with sharing on, a second customer links to the same company and is associated",
    shared?.remoteId === relinked?.remoteId &&
      associations.includes(`${c2Contact?.remoteId}->${shared?.remoteId}`),
  );
  let refused = false;
  try {
    await updateConnection(orgId, biz.id, {
      settings: { customers: { multipleCustomersPerCompany: false } },
    });
  } catch {
    refused = true;
  }
  ok("sharing cannot be turned off once on", refused);
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
console.log(failed ? "❌ HUBSPOT-CUSTOMERS: FAIL" : "✅ HUBSPOT-CUSTOMERS: PASS");
process.exit(failed ? 1 : 0);
