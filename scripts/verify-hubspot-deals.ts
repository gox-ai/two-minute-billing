/**
 * HubSpot sync, phase 3: subscriptions → deals — against a local stand-in for HubSpot.
 * No request leaves this process.
 *
 * What regresses without this:
 *  1. deals sync while deal sync is off, or for statuses outside the chosen set.
 *  2. a new deal carries the wrong name, amount (minor units, or MRR where ARR was asked),
 *     currency, pipeline or stage.
 *  3. an existing deal is not found by the subscription-id property, or the contact match picks
 *     a closed deal, an older one, or one another subscription already holds.
 *  4. "always create" still matches.
 *  5. a change is not PATCHed, an unmapped status resets the stage, or "don't update" updates.
 *  6. deals are not associated to the contact and company, or are created before the customer.
 *  7. a deal deleted in HubSpot is not re-matched; an unchanged subscription costs API calls.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-deals
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
const { createCustomer } = await import("@/modules/customers/service");
const { createProduct, createPrice } = await import("@/modules/catalog/service");
const { createSubscription, updateSubscriptionSettings } =
  await import("@/modules/subscriptions/service");
const { changeSubscription } = await import("@/modules/subscriptions/proration");
const { createDefinition } = await import("@/modules/custom-fields/service");
const { emitEvent } = await import("@/modules/events/emit");
await import("@/modules/integrations/sink");
const { REQUIRED_SCOPES } = await import("@/modules/hubspot/oauth");
const { connectHubSpot, getConnection, updateConnection } =
  await import("@/modules/hubspot/connections");
const { runSync } = await import("@/modules/hubspot/sync/engine");
const { pushSubscription } = await import("@/modules/hubspot/sync/deals");
const { HubSpotClient } = await import("@/modules/hubspot/client");
const { parseSettings } = await import("@/modules/hubspot/settings");
const { hubspotLinks, hubspotSyncItems, hubspotSyncQueue, subscriptionItems } =
  await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);

type Hit = { method: string; path: string; body: Record<string, unknown> };
const hits: Hit[] = [];
const script: Array<{ match: string; exact?: boolean; status: number; body?: unknown }> = [];
let nextId = 7000;
type Obj = "contacts" | "companies" | "deals";
const store: Record<Obj, Map<string, Record<string, string>>> = {
  contacts: new Map(),
  companies: new Map(),
  deals: new Map(),
};
/** contact id → deal ids, as HubSpot's v4 association list returns them. */
const contactDeals = new Map<string, string[]>();
const associations: string[] = [];
const UNIQUE_DEAL_PROP = "tmb_sub_id";

function seed(object: Obj, props: Record<string, string>): string {
  const id = String(nextId++);
  store[object].set(id, { createdate: new Date().toISOString(), hs_is_closed: "false", ...props });
  return id;
}
function seedDeal(props: Record<string, string>, contactId: string): string {
  const id = seed("deals", props);
  contactDeals.set(contactId, [...(contactDeals.get(contactId) ?? []), id]);
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
        hub_id: 626262,
        hub_domain: "verify.hubspot.test",
        user: "ops@verify.test",
        scopes: [...REQUIRED_SCOPES],
      });

    if (method === "GET" && /^\/crm\/v3\/properties\/\w+$/.test(path))
      return send(200, { results: [{ name: "renews_prop", label: "Renews", type: "datetime" }] });

    const assoc =
      /^\/crm\/v4\/objects\/(contacts|deals)\/(\d+)\/associations\/default\/(companies|contacts)\/(\d+)$/.exec(
        path,
      );
    if (method === "PUT" && assoc) {
      associations.push(`${assoc[1]}:${assoc[2]}->${assoc[3]}:${assoc[4]}`);
      if (assoc[1] === "deals" && assoc[3] === "contacts") {
        const list = contactDeals.get(assoc[4]!) ?? [];
        if (!list.includes(assoc[2]!)) contactDeals.set(assoc[4]!, [...list, assoc[2]!]);
      }
      return send(200, { status: "COMPLETE" });
    }
    const list = /^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/deals$/.exec(path);
    if (method === "GET" && list)
      return send(200, {
        results: (contactDeals.get(list[1]!) ?? []).map((id) => ({
          toObjectId: Number(id),
          associationTypes: [],
        })),
      });

    if (method === "POST" && path === "/crm/v3/objects/deals/batch/read") {
      const want = (body.properties as string[]) ?? [];
      const results = (body.inputs as Array<{ id: string }>)
        .filter((x) => store.deals.has(x.id))
        .map((x) => ({
          id: x.id,
          properties: Object.fromEntries(want.map((k) => [k, store.deals.get(x.id)![k] ?? null])),
        }));
      return send(200, { status: "COMPLETE", results });
    }

    const search = /^\/crm\/v3\/objects\/(contacts|companies|deals)\/search$/.exec(path);
    if (method === "POST" && search) {
      const f = (
        body.filterGroups as Array<{ filters: Array<{ propertyName: string; value: string }> }>
      )[0]!.filters[0]!;
      const want = (body.properties as string[]) ?? [];
      for (const [id, p] of store[search[1] as Obj]) {
        if ((p[f.propertyName] ?? "").toLowerCase() === f.value.toLowerCase())
          return send(200, {
            total: 1,
            results: [{ id, properties: Object.fromEntries(want.map((k) => [k, p[k] ?? null])) }],
          });
      }
      return send(200, { total: 0, results: [] });
    }

    const create = /^\/crm\/v3\/objects\/(contacts|companies|deals)$/.exec(path);
    if (method === "POST" && create) {
      const object = create[1] as Obj;
      const p = (body.properties ?? {}) as Record<string, string>;
      const uniq = object === "contacts" ? "email" : object === "deals" ? UNIQUE_DEAL_PROP : null;
      if (uniq && p[uniq]) {
        const dup = [...store[object]].find(([, c]) => c[uniq] === p[uniq]);
        if (dup) return send(409, { message: `Object already exists. Existing ID: ${dup[0]}` });
      }
      return send(201, { id: seed(object, p) });
    }

    const one = /^\/crm\/v3\/objects\/(contacts|companies|deals)\/(\d+)$/.exec(path);
    if (one) {
      const rec = store[one[1] as Obj].get(one[2]!);
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

  const org = await createOrganization({ name: `HS Deals ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "HS Deals Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await connectHubSpot({ organizationId: orgId, businessId: biz.id, code: "good-code", apiBase });
  let conn = (await getConnection(orgId, biz.id))!;

  const setSettings = async (patch: Record<string, unknown>) => {
    await updateConnection(orgId, biz.id, { settings: patch });
    conn = (await getConnection(orgId, biz.id))!;
  };
  const reset = () => {
    hits.length = 0;
    associations.length = 0;
  };
  const sync = async () => {
    reset();
    const r = await runSync(conn, "event");
    const items = r.run
      ? await withTenant(orgId, (tx) =>
          tx.select().from(hubspotSyncItems).where(eq(hubspotSyncItems.runId, r.run!.id)),
        )
      : [];
    return { ...r, items };
  };
  const dealLink = async (subId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(hubspotLinks)
          .where(
            and(
              eq(hubspotLinks.localType, "subscription"),
              eq(hubspotLinks.localId, subId),
              eq(hubspotLinks.remoteType, "deal"),
            ),
          ),
      )
    )[0];
  const customerLink = async (customerId: string, type: string) =>
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
  const dealPosts = () =>
    hits.filter((h) => h.method === "POST" && h.path === "/crm/v3/objects/deals");
  const dealPatches = (id?: string) =>
    hits.filter(
      (h) => h.method === "PATCH" && h.path.startsWith(`/crm/v3/objects/deals/${id ?? ""}`),
    );
  const dealCalls = () => hits.filter((h) => h.path.includes("/deals"));
  const propsOf = (h: Hit | undefined) => (h?.body.properties ?? {}) as Record<string, string>;
  const itemOf = (o: { items: Array<typeof hubspotSyncItems.$inferSelect> }) =>
    o.items.find((i) => i.localType === "subscription");

  await setSettings({
    products: { enabled: false },
    deals: {
      pipelineId: "pl_sales",
      stageMap: {
        active: "closedwon",
        in_trial: "decisionmakerboughtin",
        future: "appointmentscheduled",
      },
    },
  });

  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Growth",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });

  let n = 0;
  const customer = (
    fields: Omit<Parameters<typeof createCustomer>[0], "organizationId" | "businessId"> = {},
  ) => {
    n += 1;
    return createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `buyer${n}@d${n}-${RUN}.test`,
      company: `Co ${n}`,
      ...fields,
    });
  };
  const subscribe = async (
    customerId: string,
    opts: { quantity?: number; trialDays?: number; publicId?: string } = {},
  ) =>
    (
      await createSubscription({
        organizationId: orgId,
        businessId: biz.id,
        customerId,
        now: new Date(),
        items: [{ price, quantity: opts.quantity ?? 1 }],
        ...(opts.trialDays ? { trialDays: opts.trialDays } : {}),
        ...(opts.publicId ? { publicId: opts.publicId } : {}),
      })
    ).subscription;
  const setQuantity = async (subId: string, quantity: number) => {
    const [item] = await withTenant(orgId, (tx) =>
      tx
        .select({ ref: subscriptionItems.publicId })
        .from(subscriptionItems)
        .where(eq(subscriptionItems.subscriptionId, subId)),
    );
    await changeSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: subId,
      now: new Date(),
      changes: [{ itemId: item!.ref, newQuantity: quantity }],
    });
  };
  // A settings edit emits no event of its own, so the edit's event is emitted here.
  const touch = async (
    subPublicId: string,
    fields: Omit<
      Parameters<typeof updateSubscriptionSettings>[0],
      "organizationId" | "businessId" | "subscriptionPublicId"
    >,
  ) => {
    await updateSubscriptionSettings({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionPublicId: subPublicId,
      ...fields,
    });
    await withTenant(orgId, (tx) =>
      emitEvent(tx, {
        organizationId: orgId,
        businessId: biz.id,
        type: "subscription_changed",
        data: { subscription: { id: subPublicId } },
        resource: { type: "subscription", id: subPublicId },
      }),
    );
  };

  // ── Disabled → no deal calls.
  await setSettings({ deals: { enabled: false } });
  await subscribe((await customer()).id);
  let r = await sync();
  ok(
    "with deal sync off, a subscription costs no deal call",
    dealCalls().length === 0 && itemOf(r)?.message === "Deal sync is off",
  );
  await setSettings({ deals: { enabled: true } });

  // ── Status filter.
  await setSettings({ deals: { statuses: ["active"] } });
  await subscribe((await customer()).id, { trialDays: 14 });
  r = await sync();
  ok(
    "a status outside the chosen set is skipped without a deal call",
    dealCalls().length === 0 &&
      itemOf(r)?.action === "skipped" &&
      /In trial subscriptions do not sync/.test(itemOf(r)?.message ?? ""),
  );
  await setSettings({ deals: { statuses: ["future", "in_trial", "active", "non_renewing"] } });

  // ── Create, customer pushed first (handler called directly: the queue order is not ours to pick).
  const c1 = await customer({ firstName: "Ada", lastName: "Lovelace" });
  const s1 = await subscribe(c1.id);
  await withTenant(orgId, (tx) =>
    tx.delete(hubspotSyncQueue).where(eq(hubspotSyncQueue.connectionId, conn.id)),
  );
  reset();
  const direct = await pushSubscription(
    { client: new HubSpotClient(conn), conn, settings: parseSettings(conn.settings) },
    s1.id,
  );
  const contactPost = hits.findIndex(
    (h) => h.method === "POST" && h.path === "/crm/v3/objects/contacts",
  );
  const dealPost = hits.findIndex((h) => h.method === "POST" && h.path === "/crm/v3/objects/deals");
  ok(
    "an unlinked customer is pushed before the deal is created",
    contactPost >= 0 &&
      dealPost > contactPost &&
      !!(await customerLink(c1.id, "contact")) &&
      direct.some((o) => o.remoteType === "contact" && o.action === "created") &&
      direct.some((o) => o.remoteType === "deal" && o.action === "created"),
  );
  const d1 = propsOf(hits[dealPost]);
  ok("the deal is named from the format", d1.dealname === `${c1.publicId} ${s1.publicId}`);
  ok("the amount is MRR in major units", d1.amount === "50.00");
  ok("the currency is the subscription's", d1.deal_currency_code === "USD");
  ok(
    "pipeline and mapped stage are set",
    d1.pipeline === "pl_sales" && d1.dealstage === "closedwon",
  );
  const l1 = await dealLink(s1.id);
  const c1Contact = (await customerLink(c1.id, "contact"))!.remoteId;
  const c1Company = (await customerLink(c1.id, "company"))!.remoteId;
  ok(
    "the deal is linked and associated to the contact and company",
    !!l1 &&
      associations.includes(`deals:${l1.remoteId}->contacts:${c1Contact}`) &&
      associations.includes(`deals:${l1.remoteId}->companies:${c1Company}`),
  );

  // ── Hash-skip.
  await touch(s1.publicId, { poNumber: `PO-${RUN}` });
  r = await sync();
  ok(
    "an unchanged subscription costs no deal call",
    dealCalls().length === 0 && itemOf(r) === undefined && r.skipped >= 1,
  );

  // ── Change → PATCH with the new amount; then a remapped stage.
  await setQuantity(s1.id, 3);
  r = await sync();
  ok(
    "a quantity change PATCHes the linked deal with the new amount",
    dealPosts().length === 0 &&
      propsOf(dealPatches(l1!.remoteId)[0]).amount === "150.00" &&
      itemOf(r)?.action === "updated",
  );
  await setSettings({
    deals: {
      stageMap: {
        active: "contractsent",
        in_trial: "decisionmakerboughtin",
        future: "appointmentscheduled",
      },
    },
  });
  await touch(s1.publicId, { poNumber: `PO2-${RUN}` });
  await sync();
  ok(
    "a new stage for the status is PATCHed",
    propsOf(dealPatches(l1!.remoteId)[0]).dealstage === "contractsent",
  );

  // ── Unmapped status keeps the stage.
  await touch(s1.publicId, { remainingBillingCycles: 0 });
  await sync();
  const unmapped = propsOf(dealPatches(l1!.remoteId)[0]);
  ok(
    "an unmapped status (non-renewing) leaves pipeline and stage alone",
    dealPatches(l1!.remoteId).length === 1 &&
      !("dealstage" in unmapped) &&
      !("pipeline" in unmapped) &&
      store.deals.get(l1!.remoteId)!.dealstage === "contractsent",
  );

  // ── ARR.
  await setSettings({ deals: { amount: "arr" } });
  const c2 = await customer();
  const s2 = await subscribe(c2.id);
  await sync();
  ok("the ARR option sends MRR × 12", propsOf(dealPosts()[0]).amount === "600.00");
  await setSettings({ deals: { amount: "mrr" } });

  // ── onChange nothing, and updates to HubSpot off.
  await setSettings({ deals: { onChange: "nothing" } });
  await setQuantity(s2.id, 2);
  r = await sync();
  ok(
    "with deal updates off, a change is not PATCHed",
    dealPatches().length === 0 && itemOf(r)?.message === "Deal updates are off",
  );
  await setSettings({ deals: { onChange: "update" }, updates: { localChange: "nothing" } });
  await setQuantity(s2.id, 4);
  r = await sync();
  ok(
    "with updates to HubSpot off, a change is not PATCHed",
    dealPatches().length === 0 && itemOf(r)?.message === "Updates to HubSpot are off",
  );
  await setSettings({ updates: { localChange: "overwrite_remote" } });

  // ── 404 → re-match (nothing matches, so a new deal).
  const l2 = (await dealLink(s2.id))!;
  store.deals.delete(l2.remoteId);
  await setQuantity(s2.id, 5);
  await sync();
  const l2b = await dealLink(s2.id);
  ok(
    "a deal deleted in HubSpot is re-matched and re-created",
    dealPatches(l2.remoteId).length === 1 &&
      dealPosts().length === 1 &&
      !!l2b &&
      l2b.remoteId !== l2.remoteId &&
      propsOf(dealPosts()[0]).amount === "250.00",
  );

  // ── Match by the subscription-id property.
  await setSettings({ deals: { subscriptionIdProperty: UNIQUE_DEAL_PROP } });
  const s3Id = `sub_hsd_${RUN}_3`;
  const c3 = await customer();
  const preDeal = seed("deals", { [UNIQUE_DEAL_PROP]: s3Id, dealname: "Imported" });
  const s3 = await subscribe(c3.id, { publicId: s3Id });
  r = await sync();
  const idSearch = hits.find((h) => h.path === "/crm/v3/objects/deals/search");
  const idFilter = (
    idSearch?.body.filterGroups as Array<{ filters: Array<Record<string, string>> }> | undefined
  )?.[0]?.filters[0];
  ok(
    "a deal is matched on the subscription-id property",
    idFilter?.propertyName === UNIQUE_DEAL_PROP &&
      idFilter.value === s3Id &&
      dealPosts().length === 0 &&
      (await dealLink(s3.id))?.remoteId === preDeal &&
      store.deals.get(preDeal)!.dealname === `${c3.publicId} ${s3Id}` &&
      /matched on/.test(itemOf(r)?.message ?? ""),
  );
  const c3b = await customer();
  const s3b = await subscribe(c3b.id);
  await sync();
  ok(
    "a new deal carries the subscription id in that property",
    propsOf(dealPosts()[0])[UNIQUE_DEAL_PROP] === s3b.publicId,
  );

  // A 409 on create is the match (search lags creation).
  const lagId = `sub_hsd_${RUN}_lag`;
  const lagDeal = seed("deals", { [UNIQUE_DEAL_PROP]: lagId });
  script.push({
    match: "POST /crm/v3/objects/deals/search",
    status: 200,
    body: { total: 0, results: [] },
  });
  const sLag = await subscribe((await customer()).id, { publicId: lagId });
  await sync();
  ok(
    "a 409 on deal create links to the deal HubSpot names",
    (await dealLink(sLag.id))?.remoteId === lagDeal,
  );
  await setSettings({ deals: { subscriptionIdProperty: null } });

  // ── Match by contact association: newest OPEN, not held by another subscription.
  const c4Email = `assoc@a-${RUN}.test`;
  const c4Contact = seed("contacts", { email: c4Email });
  const older = seedDeal({ createdate: "2026-01-01T00:00:00Z" }, c4Contact);
  const newest = seedDeal({ createdate: "2026-05-01T00:00:00Z" }, c4Contact);
  seedDeal({ createdate: "2026-06-01T00:00:00Z", hs_is_closed: "true" }, c4Contact);
  contactDeals.get(c4Contact)!.push(l1!.remoteId); // s1's deal: created today, open, already held
  const c4 = await customer({ email: c4Email });
  const s4 = await subscribe(c4.id);
  r = await sync();
  ok(
    "the contact match links the newest open deal, skipping closed and already-linked ones",
    (await dealLink(s4.id))?.remoteId === newest &&
      dealPosts().length === 0 &&
      hits.some((h) => h.path === `/crm/v4/objects/contacts/${c4Contact}/associations/deals`) &&
      hits.some((h) => h.path === "/crm/v3/objects/deals/batch/read"),
  );
  const s4b = await subscribe(c4.id);
  await sync();
  ok(
    "a second subscription on the same contact takes the next open deal",
    (await dealLink(s4b.id))?.remoteId === older,
  );

  // ── Create mode never matches.
  await setSettings({ deals: { mode: "create" } });
  const c5Email = `create@c-${RUN}.test`;
  const c5Contact = seed("contacts", { email: c5Email });
  const bait = seedDeal({ createdate: "2026-05-01T00:00:00Z" }, c5Contact);
  const s5 = await subscribe((await customer({ email: c5Email })).id);
  await sync();
  const l5 = await dealLink(s5.id);
  ok(
    "create mode always creates a new deal",
    dealPosts().length === 1 &&
      !!l5 &&
      l5.remoteId !== bait &&
      !hits.some((h) => h.path.includes("/associations/deals")) &&
      !hits.some((h) => h.path === "/crm/v3/objects/deals/search"),
  );
  await setSettings({ deals: { mode: "link_or_create" } });

  // ── A customer HubSpot cannot hold still gets its deal, unassociated.
  const noEmail = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    firstName: "No",
    lastName: "Email",
  });
  const s6 = await subscribe(noEmail.id);
  r = await sync();
  ok(
    "a customer without a contact still syncs its deal, with the reason on the log",
    !!(await dealLink(s6.id)) &&
      !associations.some((a) => a.startsWith("deals:")) &&
      /no HubSpot contact/.test(itemOf(r)?.message ?? ""),
  );

  // ── Trial stage, name tokens, field mappings, next-billing amount.
  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "subscription",
    apiName: "region",
    label: "Region",
    dataType: "string",
  });
  await setSettings({
    customers: {
      contactFields: [
        { remote: "sub_id_prop", local: "subscription_id", direction: "to_remote" },
        { remote: "sub_status_prop", local: "subscription_status", direction: "to_remote" },
        { remote: "sub_plan_prop", local: "subscription_plan_id", direction: "to_remote" },
        { remote: "sub_amount_prop", local: "subscription_plan_amount", direction: "to_remote" },
        { remote: "sub_mrr_prop", local: "subscription_mrr", direction: "to_remote" },
        { remote: "sub_currency_prop", local: "subscription_currency", direction: "to_remote" },
      ],
    },
    deals: {
      nameFormat: "{plan} for {customer_name} at {company}",
      amount: "next_billing_amount",
      fields: [
        { remote: "plan_prop", local: "plan", direction: "to_remote" },
        { remote: "plan_id_prop", local: "plan_id", direction: "to_remote" },
        { remote: "plan_amount_prop", local: "plan_amount", direction: "to_remote" },
        { remote: "renews_prop", local: "next_billing_at", direction: "to_remote" },
        { remote: "region_prop", local: "cf_region", direction: "to_remote" },
        { remote: "pulled_prop", local: "status", direction: "to_local" },
      ],
    },
  });
  const c7 = await customer({ firstName: "Grace", lastName: "Hopper", company: "Navy" });
  const s7 = await subscribe(c7.id, { trialDays: 10 });
  await touch(s7.publicId, { customFields: { region: "EMEA" } });
  await sync();
  const d7 = propsOf(dealPosts()[0]);
  ok("a trial maps to its stage", d7.dealstage === "decisionmakerboughtin");
  ok(
    "name tokens plan, customer name and company resolve",
    d7.dealname === "Growth for Grace Hopper at Navy",
  );
  ok("the next-billing option sends the renewal estimate in major units", d7.amount === "50.00");
  ok(
    "deal field mappings push plan, a datetime and a custom field; to_local is not pushed",
    d7.plan_prop === "Growth" &&
      d7.renews_prop === String(s7.trialEnd?.getTime()) &&
      d7.region_prop === "EMEA" &&
      !("pulled_prop" in d7),
  );
  ok(
    "deal plan_id is the price public id and plan_amount is unit price x quantity",
    d7.plan_id_prop === price.publicId && d7.plan_amount_prop === "50.00",
  );
  // The contact carries the customer's current subscription, as the deal does.
  const c7Props = Object.assign(
    {},
    ...hits
      .filter((h) => h.method === "POST" && h.path === "/crm/v3/objects/contacts")
      .map(propsOf)
      .filter((p) => p.email === c7.email),
  ) as Record<string, string>;
  ok(
    "contact subscription_* fields mirror the current subscription",
    c7Props.sub_id_prop === s7.publicId &&
      c7Props.sub_status_prop === "in_trial" &&
      c7Props.sub_plan_prop === price.publicId &&
      c7Props.sub_amount_prop === "50.00" &&
      c7Props.sub_mrr_prop === "0.00" &&
      c7Props.sub_currency_prop === "USD",
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
console.log(failed ? "❌ HUBSPOT-DEALS: FAIL" : "✅ HUBSPOT-DEALS: PASS");
process.exit(failed ? 1 : 0);
