/**
 * HubSpot phase 6: the endpoints the HubSpot app calls — record card, card "Create subscription",
 * and the create/edit workflow actions — driven over HTTP with HubSpot-style signatures against a
 * local stand-in for HubSpot. No request leaves this process.
 *
 * What regresses without this:
 *  1. an unsigned, mis-signed or stale request reaches billing data (the routes carry no API key).
 *  2. a portal shared by several businesses answers for the wrong one.
 *  3. the card shows another business's records, or breaks on an unlinked record.
 *  4. "Create subscription" works while the business has it turned off.
 *  5. the deal type stops deciding create vs edit, or a deal discount is dropped.
 *  6. a retried workflow action (same callbackId) bills a second subscription.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-app
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Pinned, not inherited from .env: config is read at import.
process.env.HUBSPOT_CLIENT_ID = "verify-client-id";
process.env.HUBSPOT_CLIENT_SECRET = "verify-client-secret";
process.env.HUBSPOT_REDIRECT_URI = "http://localhost:4100/integrations/hubspot/callback";
process.env.WEBHOOK_BASE_URL = "https://api.billing.test";
process.env.DASHBOARD_BASE_URL = "https://dash.billing.test";

const SECRET = "verify-client-secret";
const BASE = "https://api.billing.test";

const { and, eq, sql } = await import("drizzle-orm");
const { closeDb, withTenant } = await import("@/platform/db");
const { encryptSecret } = await import("@/platform/secrets");
const { publicId } = await import("@/platform/ids");
const { buildApp } = await import("@/index");
const { createOrganization, createBusiness } = await import("@/modules/tenancy/service");
const { createCustomer } = await import("@/modules/customers/service");
const { createProduct, createPrice } = await import("@/modules/catalog/service");
const { updateConnection } = await import("@/modules/hubspot/connections");
const { resolvePortalConnection, HubSpotAppError } = await import("@/modules/hubspot/app/resolve");
const {
  appliedCoupons,
  customers,
  hubspotActionExecutions,
  hubspotConnections,
  hubspotLinks,
  subscriptionItems,
  subscriptions,
} = await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);
const PORTAL_A = String(700000000 + Math.floor(Math.random() * 9_000_000));
const PORTAL_SHARED = String(Number(PORTAL_A) + 1);

// ── HubSpot stand-in: contacts, deal associations, deal properties ─────────
const contacts: Record<string, { email: string; firstname: string; lastname: string }> = {
  "501": { email: `new-${RUN}@verify.test`, firstname: "Nia", lastname: "New" },
  "502": { email: `linked-${RUN}@verify.test`, firstname: "Lee", lastname: "Linked" },
};
const dealContact: Record<string, string> = {
  "9001": "502",
  "9002": "502",
  "9003": "502",
  "9004": "502",
};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  req.on("end", () => {
    const path = req.url ?? "";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const contact = /^\/crm\/v3\/objects\/contacts\/(\d+)/.exec(path);
    if (contact && contacts[contact[1]!])
      return send(200, { id: contact[1], properties: contacts[contact[1]!] });
    const assoc = /^\/crm\/v4\/objects\/deals\/(\d+)\/associations\/(contacts|companies)/.exec(
      path,
    );
    if (assoc) {
      const to = assoc[2] === "contacts" ? dealContact[assoc[1]!] : undefined;
      return send(200, { results: to ? [{ toObjectId: Number(to) }] : [] });
    }
    send(404, { message: `unexpected ${req.method} ${path}` });
  });
});

// ── Signing, the way HubSpot does it ───────────────────────────────────────
/** v3 over the URI with HubSpot's decode set applied (so `%40` is signed as `@`). */
function v3(method: string, url: string, body: string, ts = String(Date.now())) {
  const uri = `${BASE}${url}`.replace(/%40/g, "@");
  const sig = createHmac("sha256", SECRET).update(`${method}${uri}${body}${ts}`).digest("base64");
  return { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts };
}
function v2(method: string, url: string, body: string) {
  const sig = createHash("sha256").update(`${SECRET}${method}${BASE}${url}${body}`).digest("hex");
  return { "x-hubspot-signature": sig, "x-hubspot-signature-version": "v2" };
}

const app = await buildApp({ logger: false });

async function post(
  url: string,
  payload: unknown,
  sign: "v3" | "v2" | Record<string, string> = "v3",
) {
  const body = JSON.stringify(payload);
  const headers =
    sign === "v3" ? v3("POST", url, body) : sign === "v2" ? v2("POST", url, body) : sign;
  const res = await app.inject({
    method: "POST",
    url,
    payload: body,
    headers: { "content-type": "application/json", ...headers },
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}
const cardUrl = (portal: string) =>
  `/v1/hubspot/app/card?userId=42&userEmail=rep%40verify.test&appId=54407071&portalId=${portal}`;
const createUrl = (portal: string) => `/v1/hubspot/app/subscriptions?userId=42&portalId=${portal}`;
const CREATE_ACTION = "/v1/hubspot/app/actions/create-subscription";
const EDIT_ACTION = "/v1/hubspot/app/actions/edit-subscription";

async function connect(orgId: string, businessId: string, portal: string, apiBase: string) {
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .insert(hubspotConnections)
      .values({
        organizationId: orgId,
        businessId,
        publicId: publicId("hsc"),
        portalId: portal,
        accessTokenEnc: encryptSecret(`at-${RUN}`),
        refreshTokenEnc: encryptSecret(`rt-${RUN}`),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        status: "active",
        apiBase,
        initialSync: "done",
        scopes: ["automation"],
      })
      .returning(),
  );
  return row!;
}
async function link(
  conn: { organizationId: string; businessId: string; id: string },
  localType: string,
  localId: string,
  remoteType: string,
  remoteId: string,
) {
  await withTenant(conn.organizationId, (tx) =>
    tx.insert(hubspotLinks).values({
      organizationId: conn.organizationId,
      businessId: conn.businessId,
      connectionId: conn.id,
      localType,
      localId,
      remoteType,
      remoteId,
    }),
  );
}
const subsOf = (orgId: string, customerId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.customerId, customerId)),
  );

function workflow(
  callbackId: string,
  portal: string,
  dealId: string,
  dealtype: string,
  inputFields: Record<string, unknown>,
) {
  return {
    callbackId,
    origin: { portalId: Number(portal), actionDefinitionId: 1, actionDefinitionVersion: 1 },
    context: { source: "WORKFLOWS", workflowId: 77 },
    object: { objectId: Number(dealId), objectType: "DEAL", properties: { dealtype } },
    inputFields,
  };
}

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await createOrganization({ name: `HS App ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "HS App Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: `Seats ${RUN}`,
    kind: "plan",
  });
  const perSeat = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const trialPlan = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    name: "Trial",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
    trialPeriod: 14,
    trialPeriodUnit: "day",
  });
  const conn = await connect(orgId, biz.id, PORTAL_A, apiBase);
  const linked = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: contacts["502"]!.email,
    firstName: "Lee",
    lastName: "Linked",
    autoCollection: "off",
  });
  await link(conn, "customer", linked.id, "contact", "502");

  // Two businesses in different organizations share one portal.
  const orgB = await createOrganization({ name: `HS App B ${RUN}` });
  const bizB = await createBusiness({
    organizationId: orgB.organization.id,
    name: "B",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const orgC = await createOrganization({ name: `HS App C ${RUN}` });
  const bizC = await createBusiness({
    organizationId: orgC.organization.id,
    name: "C",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const connB = await connect(orgB.organization.id, bizB.id, PORTAL_SHARED, apiBase);
  const connC = await connect(orgC.organization.id, bizC.id, PORTAL_SHARED, apiBase);
  const custC = await createCustomer({
    organizationId: orgC.organization.id,
    businessId: bizC.id,
    email: `c-${RUN}@verify.test`,
  });
  await link(connC, "customer", custC.id, "contact", "777");

  // 1. Signatures.
  const cardBody = { objectId: 502, objectType: "0-1" };
  let r = await post(cardUrl(PORTAL_A), cardBody);
  ok(
    "a v3-signed card request is accepted (query string with %40 decoded)",
    r.status === 200 && r.body.object === "hubspot_card",
  );
  r = await post(cardUrl(PORTAL_A), cardBody, {
    "x-hubspot-signature-v3": "bm9wZQ==",
    "x-hubspot-request-timestamp": String(Date.now()),
  });
  ok(
    "a bad v3 signature is refused",
    r.status === 401 && r.body.error?.code === "invalid_signature",
  );
  r = await post(
    cardUrl(PORTAL_A),
    cardBody,
    v3("POST", cardUrl(PORTAL_A), JSON.stringify(cardBody), String(Date.now() - 6 * 60_000)),
  );
  ok(
    "a stale timestamp is refused even with a valid signature",
    r.status === 401 && /Stale/.test(r.body.error?.message),
  );
  r = await post(cardUrl(PORTAL_A), cardBody, {});
  ok("an unsigned request is refused", r.status === 401);
  r = await post(cardUrl(PORTAL_A), cardBody, "v2");
  ok("the card refuses v2 signatures (no timestamp to bound replay)", r.status === 401);
  r = await post(
    cardUrl(PORTAL_A),
    { ...cardBody, objectId: 503 },
    v3("POST", cardUrl(PORTAL_A), JSON.stringify(cardBody)),
  );
  ok("a signature over a different body is refused", r.status === 401);

  // 2. Portal → connection.
  const err = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => (e instanceof HubSpotAppError ? e.code : String(e)),
    );
  ok(
    "an unknown portal is not connected",
    (await err(resolvePortalConnection("1"))) === "portal_not_connected",
  );
  ok(
    "a portal with one connection resolves to it",
    (await resolvePortalConnection(PORTAL_A)).id === conn.id,
  );
  ok(
    "a shared portal without a linked record is ambiguous",
    (await err(
      resolvePortalConnection(PORTAL_SHARED, { remoteType: "contact", remoteId: "1" }),
    )) === "ambiguous_portal",
  );
  ok(
    "a shared portal resolves to the business whose links hold the record",
    (await resolvePortalConnection(PORTAL_SHARED, { remoteType: "contact", remoteId: "777" }))
      .id === connC.id,
  );
  r = await post(cardUrl(PORTAL_SHARED), { objectId: 777, objectType: "CONTACT" });
  ok(
    "the card on a shared portal shows the owning business's customer",
    r.status === 200 &&
      r.body.customers?.[0]?.id === custC.publicId &&
      r.body.business?.id === bizC.publicId,
  );
  void connB;

  // 3. Card payloads, manual create off.
  r = await post(cardUrl(PORTAL_A), { objectId: 501, objectType: "0-1" });
  ok(
    "an unlinked contact gets a friendly not-linked card",
    r.status === 200 && r.body.linked === false && r.body.customers.length === 0,
  );
  ok(
    "with manual create off the card offers no button and no plans",
    r.body.manual_create === false && r.body.can_create === false && r.body.plans.length === 0,
  );
  r = await post(createUrl(PORTAL_A), {
    objectId: 501,
    objectType: "0-1",
    priceId: trialPlan.publicId,
    quantity: 1,
    requestId: `req-${RUN}-off`,
  });
  ok(
    "create subscription is refused while manual create is off",
    r.status === 403 && r.body.error?.code === "manual_create_disabled",
  );

  // 4. Manual create on: a new contact becomes a linked customer with a subscription.
  await updateConnection(orgId, biz.id, { settings: { deals: { manualCreate: true } } });
  r = await post(cardUrl(PORTAL_A), { objectId: 501, objectType: "0-1" });
  ok(
    "with manual create on the card lists the business's plans",
    r.body.can_create === true && r.body.plans.some((p: any) => p.id === perSeat.publicId),
  );
  const cardCreate = {
    objectId: 501,
    objectType: "0-1",
    priceId: trialPlan.publicId,
    quantity: 1,
    requestId: `req-${RUN}-1`,
  };
  r = await post(createUrl(PORTAL_A), cardCreate);
  const [created] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.email, contacts["501"]!.email)),
  );
  const createdLinks = created
    ? await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(hubspotLinks)
          .where(and(eq(hubspotLinks.localId, created.id), eq(hubspotLinks.remoteId, "501"))),
      )
    : [];
  ok(
    "the card creates the customer from the contact and links it",
    r.status === 201 && !!created && createdLinks.length === 1 && created.firstName === "Nia",
  );
  ok(
    "the new subscription runs through the billing engine (plan trial applied)",
    r.body.subscription?.status === "in_trial" &&
      r.body.card?.linked === true &&
      r.body.card.customers[0].subscriptions.length === 1,
  );

  const firstCardSub = r.body.subscription?.id;
  const replay = await post(createUrl(PORTAL_A), cardCreate);
  const cardSubs = created ? await subsOf(orgId, created.id) : [];
  ok(
    "a repeated card create (double click) replays the first result and bills once",
    replay.status === 201 && replay.body.subscription?.id === firstCardSub && cardSubs.length === 1,
  );

  // 5. Workflow create, price override discount.
  const createPayload = workflow(`cb-${RUN}-1`, PORTAL_A, "9001", "newbusiness", {
    price_id: perSeat.publicId,
    quantity: "2",
    discount_percent: "10",
  });
  r = await post(CREATE_ACTION, createPayload, "v2");
  const first = r.body;
  const subsAfterCreate = await subsOf(orgId, linked.id);
  ok(
    "a v2-signed workflow create succeeds",
    r.status === 200 && first.outputFields?.hs_execution_state === "SUCCESS",
  );
  const sub1 = subsAfterCreate.find((s) => s.publicId === first.outputFields?.subscription_id);
  const [item1] = sub1
    ? await withTenant(orgId, (tx) =>
        tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub1.id)),
      )
    : [];
  ok(
    "the workflow subscription bills the deal's contact",
    !!sub1 && first.outputFields.customer_id === linked.publicId,
  );
  ok(
    "price_override lowers the unit price by the deal discount",
    item1?.quantity === 2 &&
      (item1?.priceSnapshot as { amountMinor?: number } | null)?.amountMinor === 9000,
  );
  const dealLink = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(hubspotLinks)
      .where(and(eq(hubspotLinks.remoteType, "deal"), eq(hubspotLinks.remoteId, "9001"))),
  );
  ok(
    "the deal is linked to its subscription",
    dealLink.length === 1 && dealLink[0]!.localId === sub1?.id,
  );

  // 6. Replay.
  r = await post(CREATE_ACTION, createPayload, "v2");
  // jsonb stores keys in its own order, so compare canonically.
  const canon = (o: Record<string, unknown>) =>
    JSON.stringify(Object.entries(o.outputFields as object).sort());
  ok("a replayed callbackId returns the first result", canon(r.body) === canon(first));
  ok(
    "a replay creates no second subscription",
    (await subsOf(orgId, linked.id)).length === subsAfterCreate.length,
  );

  // 7. Deal type decides create vs edit.
  r = await post(
    CREATE_ACTION,
    workflow(`cb-${RUN}-2`, PORTAL_A, "9002", "existingbusiness", { price_id: perSeat.publicId }),
    "v2",
  );
  ok(
    "create refuses a deal type set to edit",
    r.body.outputFields?.hs_execution_state === "FAIL_CONTINUE" &&
      r.body.outputFields.error_code === "deal_type_edits",
  );
  r = await post(
    EDIT_ACTION,
    workflow(`cb-${RUN}-3`, PORTAL_A, "9002", "newbusiness", { quantity: "3" }),
    "v2",
  );
  ok(
    "edit refuses a deal type that creates",
    r.body.outputFields?.error_code === "deal_type_creates",
  );
  r = await post(
    EDIT_ACTION,
    workflow(`cb-${RUN}-4`, PORTAL_A, "9001", "existingbusiness", { quantity: "3" }),
    "v2",
  );
  const [item1b] = sub1
    ? await withTenant(orgId, (tx) =>
        tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub1.id)),
      )
    : [];
  ok(
    "edit changes the deal's linked subscription through the engine",
    r.body.outputFields?.hs_execution_state === "SUCCESS" &&
      r.body.outputFields.subscription_id === sub1?.publicId &&
      item1b?.quantity === 3,
  );
  ok(
    "an edit creates no new subscription",
    (await subsOf(orgId, linked.id)).length === subsAfterCreate.length,
  );

  // 8. Coupon mode: the discount lands as a subscription discount, not a price change.
  await updateConnection(orgId, biz.id, { settings: { deals: { discountMode: "coupon" } } });
  r = await post(
    CREATE_ACTION,
    workflow(`cb-${RUN}-5`, PORTAL_A, "9003", "newbusiness", {
      price_id: perSeat.publicId,
      quantity: 1,
      discount_amount: "5",
    }),
    "v2",
  );
  const sub3 = (await subsOf(orgId, linked.id)).find(
    (s) => s.publicId === r.body.outputFields?.subscription_id,
  );
  const disc = sub3
    ? await withTenant(orgId, (tx) =>
        tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, sub3.id)),
      )
    : [];
  const [item3] = sub3
    ? await withTenant(orgId, (tx) =>
        tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub3.id)),
      )
    : [];
  ok(
    "coupon mode applies the deal discount as a discount at list price",
    disc.length === 1 &&
      (item3?.priceSnapshot as { amountMinor?: number } | null)?.amountMinor === 10000,
  );
  // ignore mode drops it.
  await updateConnection(orgId, biz.id, { settings: { deals: { discountMode: "ignore" } } });
  r = await post(
    CREATE_ACTION,
    workflow(`cb-${RUN}-6`, PORTAL_A, "9004", "newbusiness", {
      price_id: perSeat.publicId,
      discount_percent: 50,
    }),
    "v2",
  );
  const sub4 = (await subsOf(orgId, linked.id)).find(
    (s) => s.publicId === r.body.outputFields?.subscription_id,
  );
  const disc4 = sub4
    ? await withTenant(orgId, (tx) =>
        tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, sub4.id)),
      )
    : [];
  const [item4] = sub4
    ? await withTenant(orgId, (tx) =>
        tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub4.id)),
      )
    : [];
  ok(
    "ignore mode drops the deal discount",
    !!sub4 &&
      disc4.length === 0 &&
      (item4?.priceSnapshot as { amountMinor?: number } | null)?.amountMinor === 10000,
  );

  // 9. The linked contact's card now shows subscriptions, MRR, invoices and deep links.
  r = await post(cardUrl(PORTAL_A), { objectId: 502, objectType: "contacts" });
  const c0 = r.body.customers?.[0];
  const s0 = c0?.subscriptions?.find((s: any) => s.id === sub1?.publicId);
  ok(
    "the card for a linked contact carries subscriptions with plan, MRR and next billing",
    r.body.linked === true &&
      c0?.id === linked.publicId &&
      !!s0 &&
      s0.plan === `Seats ${RUN}` &&
      s0.mrr.minor > 0 &&
      !!s0.next_billing_at,
  );
  ok(
    "the card links into the dashboard and lists recent invoices",
    c0?.url ===
      `https://dash.billing.test/businesses/${biz.publicId}/customers/${linked.publicId}` &&
      c0.invoices.length > 0,
  );
  r = await post(cardUrl(PORTAL_A), { objectId: 9001, objectType: "0-3" });
  ok(
    "a deal's card shows only its own subscription and offers no second one",
    r.body.customers?.[0]?.subscriptions.length === 1 && r.body.can_create === false,
  );

  // 10. RLS on the executions table.
  const mine = await withTenant(orgId, (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(hubspotActionExecutions),
  );
  const stranger = await createOrganization({ name: `HS App Stranger ${RUN}` });
  const seen = await withTenant(stranger.organization.id, (tx) =>
    tx.select().from(hubspotActionExecutions),
  );
  ok(
    "executions are recorded and invisible to another organization",
    (mine[0]?.n ?? 0) >= 5 && seen.length === 0,
  );
}

try {
  await main();
} finally {
  server.close();
  await app.close();
  await closeDb();
}

let failed = 0;
for (const [name, pass] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "✅" : "❌"} ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
console.log(failed ? "❌ HUBSPOT-APP: FAIL" : "✅ HUBSPOT-APP: PASS");
process.exit(failed ? 1 : 0);
