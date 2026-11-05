/**
 * HubSpot sync, phase 5: prices → HubSpot products, against a local stand-in for HubSpot.
 * No request leaves this process.
 *
 * What regresses without this:
 *  1. a price lands with the wrong unit price, currency property, billing frequency or term.
 *  2. a product already in HubSpot under our SKU is duplicated instead of linked.
 *  3. an unchanged price re-sends; a changed one (or a renamed product) does not PATCH.
 *  4. a tiered/volume price or an unmappable frequency is pushed as a misleading single price.
 *  5. archiving a price leaves its HubSpot product live, or restoring it never brings it back.
 *  6. a price in a currency the portal lacks is written into another currency's price.
 *  7. product sync switched off still calls HubSpot.
 *
 *   pnpm verify:all:fresh -- --suite hubspot-products
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Pinned, not inherited from .env: config is read at import, and a real secret must never be sent to the stand-in.
process.env.HUBSPOT_CLIENT_ID = "verify-client-id";
process.env.HUBSPOT_CLIENT_SECRET = "verify-client-secret";
process.env.HUBSPOT_REDIRECT_URI = "http://localhost:4100/integrations/hubspot/callback";

const { eq } = await import("drizzle-orm");
const { closeDb, withTenant } = await import("@/platform/db");
const { createOrganization, createBusiness } = await import("@/modules/tenancy/service");
const { createProduct, createPrice, updatePrice, updateProduct, setPriceActive } =
  await import("@/modules/catalog/service");
await import("@/modules/integrations/sink");
const { REQUIRED_SCOPES } = await import("@/modules/hubspot/oauth");
const { connectHubSpot, getConnection } = await import("@/modules/hubspot/connections");
const { runSync } = await import("@/modules/hubspot/sync/engine");
const { hubspotConnections, hubspotLinks, hubspotSyncItems } = await import("@db/schema");

const checks: [string, boolean][] = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const RUN = randomUUID().slice(0, 8);

type Hit = { method: string; path: string; body: Record<string, unknown> };
const hits: Hit[] = [];
let nextProductId = 5000;
/** HubSpot's products: id → properties. Archived ones leave this map. */
const hsProducts = new Map<string, Record<string, string>>();
/** Product properties the portal has; a multi-currency portal has one hs_price_<code> per currency. */
let productProps = ["name", "price", "hs_sku", "hs_price_usd", "hs_price_eur"];
let dealCurrencies = ["USD", "EUR"];

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
    hits.push({ method, path, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(status === 204 ? "" : JSON.stringify(payload ?? {}));
    };

    if (method === "POST" && path === "/oauth/v1/token")
      return send(200, { access_token: `at-${RUN}`, refresh_token: `rt-${RUN}`, expires_in: 1800 });
    if (method === "GET" && path.startsWith("/oauth/v1/access-tokens/"))
      return send(200, {
        hub_id: 515151,
        hub_domain: "products.hubspot.test",
        user: "ops@verify.test",
        scopes: [...REQUIRED_SCOPES],
      });
    if (method === "GET" && path === "/crm/v3/properties/products")
      return send(200, { results: productProps.map((name) => ({ name })) });
    if (method === "GET" && path === "/crm/v3/properties/deals/deal_currency_code")
      return send(200, {
        name: "deal_currency_code",
        options: dealCurrencies.map((value) => ({ value, label: value })),
      });
    if (method === "POST" && path === "/crm/v3/objects/products/search") {
      const filter = (
        body.filterGroups as Array<{ filters: Array<{ propertyName: string; value: string }> }>
      )[0]!.filters[0]!;
      const results = [...hsProducts]
        .filter(([, p]) => p[filter.propertyName] === filter.value)
        .map(([id]) => ({ id }));
      return send(200, { total: results.length, results });
    }
    if (method === "POST" && path === "/crm/v3/objects/products") {
      const id = String(nextProductId++);
      hsProducts.set(id, { ...(body.properties as Record<string, string>) });
      return send(201, { id });
    }
    const one = /^\/crm\/v3\/objects\/products\/(\d+)$/.exec(path);
    if (one && method === "PATCH") {
      const cur = hsProducts.get(one[1]!);
      if (!cur) return send(404, { message: "resource not found" });
      Object.assign(cur, body.properties);
      return send(200, { id: one[1] });
    }
    if (one && method === "DELETE") {
      hsProducts.delete(one[1]!);
      return send(204, null);
    }
    send(404, { message: `unexpected ${method} ${path}` });
  });
});

const productWrites = () => hits.filter((h) => h.path.startsWith("/crm/v3/objects/products"));
const sentFor = (sku: string) =>
  hits.filter((h) => (h.body.properties as Record<string, string> | undefined)?.hs_sku === sku);

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await createOrganization({ name: `HS Products ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "HS Catalog",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const scope = { organizationId: orgId, businessId: biz.id };

  const pro = await createProduct({ ...scope, name: "Pro", description: "The pro plan" });
  const price = (
    p: Omit<Parameters<typeof createPrice>[0], "organizationId" | "businessId" | "productId">,
  ) => createPrice({ ...scope, productId: pro.id, ...p });
  const monthly = await price({
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const yearly = await price({
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 10000,
    interval: "year",
    name: "Annual",
  });
  const quarterlyEur = await price({
    type: "recurring",
    model: "flat",
    currency: "EUR",
    amountMinor: 2500,
    interval: "month",
    intervalCount: 3,
    billingCycles: 4,
  });
  const setup = await price({
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 4999,
  });
  const tiered = await price({
    type: "recurring",
    model: "tiered",
    currency: "USD",
    interval: "month",
    tiers: [
      { upToMinor: 10, unitAmountMinor: 100 },
      { upToMinor: null, unitAmountMinor: 80 },
    ],
  });
  const daily = await price({
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 50,
    interval: "day",
  });
  const gbp = await price({
    type: "recurring",
    model: "flat",
    currency: "GBP",
    amountMinor: 900,
    interval: "month",
  });

  // A product someone already made in HubSpot under our SKU.
  hsProducts.set("9001", { name: "Pro yearly (hand-made)", hs_sku: yearly.publicId });

  let conn = await connectHubSpot({ ...scope, code: "good-code", apiBase });
  hits.length = 0;
  let r = await runSync(conn, "initial", { full: true });
  const items = async (runId: string) =>
    withTenant(orgId, (tx) =>
      tx.select().from(hubspotSyncItems).where(eq(hubspotSyncItems.runId, runId)),
    );
  let log = await items(r.run!.id);
  const itemFor = (ref: string) => log.find((i) => i.localRef === ref);

  const m = sentFor(monthly.publicId).find((h) => h.method === "POST")?.body.properties as
    | Record<string, string>
    | undefined;
  ok(
    "a monthly flat price is created with its name, SKU, currency price and frequency",
    m?.name === "Pro (Monthly, USD)" &&
      m.hs_sku === monthly.publicId &&
      m.hs_price_usd === "10.00" &&
      m.recurringbillingfrequency === "monthly" &&
      m.description === "The pro plan" &&
      !("price" in m) &&
      !("hs_recurring_billing_period" in m),
  );
  const q = sentFor(quarterlyEur.publicId)[0]?.body.properties as
    | Record<string, string>
    | undefined;
  ok(
    "a quarterly EUR price with 4 cycles carries hs_price_eur and a 12-month term",
    q?.hs_price_eur === "25.00" &&
      q.recurringbillingfrequency === "quarterly" &&
      q.hs_recurring_billing_period === "P12M" &&
      !("hs_price_usd" in q),
  );
  const s = sentFor(setup.publicId)[0]?.body.properties as Record<string, string> | undefined;
  ok(
    "a one-time price has no billing frequency",
    s?.hs_price_usd === "49.99" && !("recurringbillingfrequency" in s),
  );

  const y = sentFor(yearly.publicId);
  ok(
    "a HubSpot product with our SKU is linked and updated, not duplicated",
    y.length === 1 &&
      y[0]!.method === "PATCH" &&
      y[0]!.path === "/crm/v3/objects/products/9001" &&
      (y[0]!.body.properties as Record<string, string>).recurringbillingfrequency === "annually" &&
      (y[0]!.body.properties as Record<string, string>).name === "Pro (Annual)" &&
      itemFor(yearly.publicId)?.remoteId === "9001",
  );
  ok(
    "a tiered price is skipped, naming the one-price limitation",
    sentFor(tiered.publicId).length === 0 &&
      itemFor(tiered.publicId)?.action === "skipped" &&
      /tiered.*one unit price/.test(itemFor(tiered.publicId)?.message ?? ""),
  );
  ok(
    "a daily price is skipped: HubSpot has no such billing frequency",
    sentFor(daily.publicId).length === 0 &&
      /no HubSpot billing frequency/.test(itemFor(daily.publicId)?.message ?? ""),
  );
  ok(
    "a price in a currency the portal lacks is skipped, not written into another currency",
    sentFor(gbp.publicId).length === 0 &&
      /GBP is not a currency/.test(itemFor(gbp.publicId)?.message ?? ""),
  );
  ok(
    "portal currencies are read once per pass",
    hits.filter((h) => h.path === "/crm/v3/properties/products").length === 1,
  );
  conn = (await getConnection(orgId, biz.id))!;
  ok(
    "the initial sweep completes with four products linked",
    conn.initialSync === "done" && hsProducts.size === 4,
  );

  const linkOf = async (priceId: string) =>
    (
      await withTenant(orgId, (tx) =>
        tx.select().from(hubspotLinks).where(eq(hubspotLinks.localId, priceId)),
      )
    )[0];
  const monthlyId = (await linkOf(monthly.id))!.remoteId;

  // Unchanged → no product call.
  await setPriceActive(orgId, biz.id, monthly.publicId, true);
  hits.length = 0;
  r = await runSync(conn, "event");
  ok("an unchanged price costs no product call", productWrites().length === 0 && r.skipped === 1);

  // Changed amount → PATCH the linked product.
  await updatePrice({ ...scope, pricePublicId: monthly.publicId, amountMinor: 1200 });
  hits.length = 0;
  r = await runSync(conn, "event");
  const patched = hits.find(
    (h) => h.method === "PATCH" && h.path === `/crm/v3/objects/products/${monthlyId}`,
  );
  ok(
    "a changed price PATCHes its product",
    (patched?.body.properties as Record<string, string> | undefined)?.hs_price_usd === "12.00" &&
      r.updated === 1 &&
      productWrites().every((h) => h.method === "PATCH"),
  );

  // Renaming the product moves every one of its synced prices.
  await updateProduct({ ...scope, productPublicId: pro.publicId, name: "Pro Plus" });
  hits.length = 0;
  r = await runSync(conn, "event");
  const renamed = productWrites().filter((h) => h.method === "PATCH");
  ok(
    "a product rename PATCHes each of its synced prices",
    renamed.length === 4 &&
      renamed.every(
        (h) =>
          (h.body.properties as Record<string, string>).name?.startsWith("Pro Plus (") === true,
      ),
  );

  // Archive → archived in HubSpot, once.
  await setPriceActive(orgId, biz.id, monthly.publicId, false);
  hits.length = 0;
  await runSync(conn, "event");
  ok(
    "archiving a price archives its HubSpot product",
    hits.some((h) => h.method === "DELETE" && h.path === `/crm/v3/objects/products/${monthlyId}`) &&
      !hsProducts.has(monthlyId),
  );
  await setPriceActive(orgId, biz.id, monthly.publicId, false);
  hits.length = 0;
  await runSync(conn, "event");
  ok("an already-archived price costs no call", productWrites().length === 0);

  // Archived and never linked → skipped.
  await setPriceActive(orgId, biz.id, tiered.publicId, false);
  hits.length = 0;
  r = await runSync(conn, "event");
  log = await items(r.run!.id);
  ok(
    "an archived price that never synced is skipped",
    productWrites().length === 0 && /never synced/.test(itemFor(tiered.publicId)?.message ?? ""),
  );

  // Restore → a fresh HubSpot product, relinked.
  await setPriceActive(orgId, biz.id, monthly.publicId, true);
  hits.length = 0;
  r = await runSync(conn, "event");
  const relinked = await linkOf(monthly.id);
  ok(
    "restoring a price creates a new HubSpot product and relinks it",
    r.created === 1 &&
      !!relinked &&
      relinked.remoteId !== monthlyId &&
      hsProducts.has(relinked.remoteId),
  );

  // Deleted in HubSpot → re-matched (none) → created.
  hsProducts.delete("9001");
  await updatePrice({ ...scope, pricePublicId: yearly.publicId, amountMinor: 11000 });
  hits.length = 0;
  r = await runSync(conn, "event");
  const yLink = await linkOf(yearly.id);
  ok(
    "a product deleted in HubSpot is searched for by SKU, then re-created",
    hits.some((h) => h.path === "/crm/v3/objects/products/search") &&
      r.created === 1 &&
      yLink?.remoteId !== "9001",
  );

  // Single-currency portal: `price` holds the one currency its deals use.
  productProps = ["name", "price", "hs_sku"];
  dealCurrencies = ["USD"];
  await updatePrice({ ...scope, pricePublicId: monthly.publicId, amountMinor: 1300 });
  await updatePrice({ ...scope, pricePublicId: quarterlyEur.publicId, amountMinor: 2600 });
  hits.length = 0;
  r = await runSync(conn, "event");
  log = await items(r.run!.id);
  const single = sentFor(monthly.publicId)[0]?.body.properties as
    | Record<string, string>
    | undefined;
  ok(
    "a single-currency portal gets `price` for its own currency and skips the rest",
    single?.price === "13.00" &&
      !("hs_price_usd" in single) &&
      sentFor(quarterlyEur.publicId).length === 0 &&
      /EUR is not a currency/.test(itemFor(quarterlyEur.publicId)?.message ?? ""),
  );

  // Product sync off → no HubSpot call at all.
  const settings = { ...(conn.settings as Record<string, unknown>), products: { enabled: false } };
  await withTenant(orgId, (tx) =>
    tx.update(hubspotConnections).set({ settings }).where(eq(hubspotConnections.id, conn.id)),
  );
  conn = (await getConnection(orgId, biz.id))!;
  await updatePrice({ ...scope, pricePublicId: monthly.publicId, amountMinor: 1400 });
  hits.length = 0;
  r = await runSync(conn, "event");
  log = await items(r.run!.id);
  ok(
    "product sync off makes no HubSpot call and says why",
    hits.every((h) => !h.path.startsWith("/crm/")) &&
      r.skipped === 1 &&
      itemFor(monthly.publicId)?.message === "Product sync is off",
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
console.log(failed ? "❌ HUBSPOT-PRODUCTS: FAIL" : "✅ HUBSPOT-PRODUCTS: PASS");
process.exit(failed ? 1 : 0);
