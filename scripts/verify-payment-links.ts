/**
 * verify:payment-links — reusable public payment links and the pricing page (E2).
 *
 * Over HTTP, because the open route's rate limit and its public, credential-free shape are
 * the point. Runs with RATE_LIMIT_PAYMENT_LINK_PER_IP=6 (package.json) so the 429 is reachable.
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { isObjectStoreConfigured, setObjectStoreDriverForTests } from "@/platform/object-store";
import { checkoutSessions, invoices, subscriptions } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label);
  }
}

const app = await buildApp({ logger: false });
await clearPublicRateLimits();

const org = await createOrganization({ name: "Links Co" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Links Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const product = async (name: string, kind: "plan" | "addon" | "charge") =>
  createProduct({ organizationId: orgId, businessId: biz.id, name, kind });
const price = async (
  productId: string,
  type: "one_time" | "recurring",
  amountMinor: number,
  currency = "USD",
) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId,
    type,
    model: "flat",
    currency,
    amountMinor,
    ...(type === "recurring" ? { interval: "month" as const } : {}),
  });
const pack = await product("Credit pack", "charge");
const packUsd = await price(pack.id, "one_time", 2500);
const packEur = await price(pack.id, "one_time", 2300, "EUR");
const plan = await product("Pro", "plan");
const planUsd = await price(plan.id, "recurring", 5000);
const plan2 = await product("Team", "plan");
const plan2Usd = await price(plan2.id, "recurring", 9000);
const seats = await product("Seats", "addon");
const seatsUsd = await price(seats.id, "recurring", 700);

const body = (r: { body: string }) => JSON.parse(r.body);
const op = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
    },
    ...(payload ? { payload } : {}),
  });
const buyer = (path: string, token: string, method: "GET" | "POST" = "GET", payload?: unknown) =>
  app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const open = (id: string) => app.inject({ method: "POST", url: `/checkout/v1/links/${id}/open` });
const address = {
  line1: "1 Market St",
  city: "San Francisco",
  state: "California",
  state_code: "CA",
  postal_code: "94105",
  country: "US",
  first_name: "Bu",
  last_name: "Yer",
};

// ── Link rules ────────────────────────────────────────────────────────────────
const refused = async (label: string, items: object[]) =>
  ok(label, (await op("POST", "/payment_links", { name: "x", items })).statusCode === 400);
await refused("rules: a recurring add-on with no plan is refused", [{ price: seatsUsd.publicId }]);
await refused("rules: two plans are refused", [
  { price: planUsd.publicId },
  { price: plan2Usd.publicId },
]);
await refused("rules: mixed currencies are refused", [
  { price: packUsd.publicId },
  { price: packEur.publicId },
]);
await refused("rules: an optional plan is refused", [{ price: planUsd.publicId, optional: true }]);
await refused("rules: an unknown price is refused", [{ price: "nope" }]);

// ── A purchase link, two buyers ───────────────────────────────────────────────
const created = await op("POST", "/payment_links", {
  name: "Credit pack offer",
  items: [{ price: packUsd.publicId }],
  show_on_pricing_page: true,
});
const link = body(created);
ok(
  "create: 201, a purchase link with a public url",
  created.statusCode === 201 && link.mode === "purchase" && /\/buy\/plink_/.test(link.url ?? ""),
);
const o1 = body(await open(link.id));
const o2 = body(await open(link.id));
ok("open: each visitor gets their own session", !!o1.token && !!o2.token && o1.token !== o2.token);
for (const [i, o] of [o1, o2].entries()) {
  await buyer("/checkout/v1/customer", o.token, "POST", {
    email: `visitor${i}@example.com`,
    address,
  });
  await buyer("/checkout/v1/complete", o.token, "POST", {});
}
const sess = await withTenant(orgId, (tx) =>
  tx
    .select({
      customer: checkoutSessions.resultingCustomerId,
      inv: checkoutSessions.resultingInvoiceId,
    })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.businessId, biz.id)),
);
const fromLink = sess.filter((s) => s.inv);
ok(
  "two buyers: two customers and two paid invoices",
  fromLink.length === 2 && new Set(fromLink.map((s) => s.customer)).size === 2,
);
const paid = await withTenant(orgId, (tx) =>
  tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.businessId, biz.id)),
);
ok("two buyers: both invoices are paid", paid.filter((p) => p.status === "paid").length === 2);
const stats = body(await op("GET", `/payment_links/${link.id}`));
ok("stats: 2 opened, 2 completed", stats.opens === 2 && stats.completions === 2);

// ── A subscription link ───────────────────────────────────────────────────────
const subLink = body(
  await op("POST", "/payment_links", {
    name: "Pro with setup",
    items: [{ price: planUsd.publicId }, { price: packUsd.publicId }],
  }),
);
ok("subscription link: mode is create", subLink.mode === "create");
const so = body(await open(subLink.id));
await buyer("/checkout/v1/customer", so.token, "POST", { email: "sub@example.com", address });
const soView = body(await buyer("/checkout/v1/session", so.token));
ok(
  "e4: a subscription checkout shows what is due today, one-time item included (5000 + 2500)",
  soView.dueToday?.trial === false && soView.dueToday?.totalMinor === 7500,
);
const subDone = body(await buyer("/checkout/v1/complete", so.token, "POST", { token: "tok_4242" }));
const subs = await withTenant(orgId, (tx) =>
  tx.select().from(subscriptions).where(eq(subscriptions.businessId, biz.id)),
);
ok(
  "subscription link: completing creates one subscription",
  !!subDone.subscription_id && subs.length === 1,
);

// ── Archive, restore ──────────────────────────────────────────────────────────
await op("PATCH", `/payment_links/${link.id}`, { active: false });
ok("archive: the public open answers 404", (await open(link.id)).statusCode === 404);
const listed = body(await op("GET", "/payment_links"));
ok(
  "archive: the default list hides it",
  !listed.data.some((l: { id: string }) => l.id === link.id),
);
const pricingArchived = body(
  await app.inject({ method: "GET", url: `/checkout/v1/pricing/${biz.publicId}` }),
);
ok("pricing: an archived link is not listed", pricingArchived.links.length === 0);
await op("PATCH", `/payment_links/${link.id}`, { active: true });
ok("restore: the link opens again", (await open(link.id)).statusCode === 201);

// ── Pricing page ──────────────────────────────────────────────────────────────
const pricing = body(
  await app.inject({ method: "GET", url: `/checkout/v1/pricing/${biz.publicId}` }),
);
ok(
  "pricing: lists only links marked for it, with the price",
  pricing.links.length === 1 &&
    pricing.links[0].id === link.id &&
    pricing.links[0].price.amount.includes("25"),
);
ok(
  "pricing: an unknown business answers 404",
  (await app.inject({ method: "GET", url: "/checkout/v1/pricing/biz_nope" })).statusCode === 404,
);
const byProduct = body(await op("GET", `/payment_links?product=${plan.publicId}`));
ok(
  "list: ?product narrows to links selling it",
  byProduct.data.length === 1 && byProduct.data[0].id === subLink.id,
);

// ── E3: the buyer edits the order within the link's limits ────────────────────
const credits = await product("API credits", "charge");
const creditsUnit = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: credits.id,
  type: "one_time",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
});
const guide = await product("Setup guide", "charge");
const guideUsd = await price(guide.id, "one_time", 500);
await refused("e3: a flat price cannot have an adjustable quantity", [
  { price: guideUsd.publicId, min_quantity: 1, max_quantity: 3 },
]);
await clearPublicRateLimits();
const cart = body(
  await op("POST", "/payment_links", {
    name: "Credits",
    items: [
      { price: creditsUnit.publicId, quantity: 1, min_quantity: 1, max_quantity: 5 },
      { price: guideUsd.publicId, optional: true },
    ],
  }),
);
const co = body(await open(cart.id));
const setItem = (p: string, q: number) =>
  buyer("/checkout/v1/items", co.token, "POST", { price: p, quantity: q });
const v0 = body(await buyer("/checkout/v1/session", co.token));
ok(
  "e3: the view lists both lines with their limits",
  v0.offer?.lines.length === 2 &&
    v0.offer.lines[0].adjustable === true &&
    v0.offer.lines[0].max === 5 &&
    v0.offer.lines[1].optional === true,
);
ok(
  "e3: a quantity within the limits is accepted",
  (await setItem(creditsUnit.publicId, 3)).statusCode === 200,
);
const v1 = body(await buyer("/checkout/v1/session", co.token));
ok("e3: the total follows the new quantity (3 × 1000 + 500)", v1.purchase?.subtotal_minor === 3500);
ok(
  "e3: a quantity above the maximum is refused",
  (await setItem(creditsUnit.publicId, 6)).statusCode === 400,
);
ok(
  "e3: a line that is not optional cannot be removed",
  (await setItem(creditsUnit.publicId, 0)).statusCode === 400,
);
ok("e3: an optional line can be removed", (await setItem(guideUsd.publicId, 0)).statusCode === 200);
ok(
  "e3: a price not on the link is refused",
  (await setItem(packUsd.publicId, 1)).statusCode === 400,
);
ok(
  "e3: the optional line can be added back",
  (await setItem(guideUsd.publicId, 1)).statusCode === 200,
);
await buyer("/checkout/v1/customer", co.token, "POST", { email: "cart@example.com", address });
const shown = body(await buyer("/checkout/v1/session", co.token)).purchase?.total_minor;
const cartDone = body(await buyer("/checkout/v1/complete", co.token, "POST", {}));
const [cartInv] = await withTenant(orgId, (tx) =>
  tx.select().from(invoices).where(eq(invoices.publicId, cartDone.invoice_id)),
);
ok(
  "e3: the amount charged equals the total shown",
  cartInv?.status === "paid" && Number(cartInv.totalMinor) === shown,
);
ok(
  "e3: a completed order cannot change",
  (await setItem(creditsUnit.publicId, 2)).statusCode !== 200,
);
const plainMint = body(
  await op("POST", "/checkout_sessions", { price: packUsd.publicId, mode: "purchase" }),
);
ok(
  "e3: a checkout not opened from a link cannot change its items",
  (
    await buyer("/checkout/v1/items", plainMint.token, "POST", {
      price: packUsd.publicId,
      quantity: 2,
    })
  ).statusCode === 400,
);

// ── Product image (0347) ──────────────────────────────────────────────────────
// Stored through a test driver, so nothing reaches the real bucket.
const storedKeys: string[] = [];
const deletedKeys: string[] = [];
setObjectStoreDriverForTests({
  sender: async (put) => void storedKeys.push(put.Key),
  deleter: async (del) => void deletedKeys.push(del.Key),
});
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const setImage = (buf: Buffer) =>
  op("POST", `/products/${pack.publicId}/image`, {
    data: buf.toString("base64"),
    content_type: "image/png",
  });
if (!isObjectStoreConfigured()) {
  ok(
    "image: with no storage configured, an upload answers 503",
    (await setImage(PNG)).statusCode === 503,
  );
} else {
  const svg = await setImage(SVG);
  ok(
    "image: an SVG is refused (400) and nothing is stored",
    svg.statusCode === 400 && storedKeys.length === 0,
  );
  const first = body(await setImage(PNG));
  ok(
    "image: a PNG is stored and set on the product",
    /\/product-[0-9a-f]+\.png$/.test(first.image_url ?? "") && storedKeys.length === 1,
  );
  const second = body(await setImage(PNG));
  ok(
    "image: a new image replaces the old one and deletes its file",
    second.image_url !== first.image_url &&
      deletedKeys.length === 1 &&
      String(first.image_url).endsWith(deletedKeys[0]!),
  );
  ok(
    "image: the product carries it",
    body(await op("GET", `/products/${pack.publicId}`)).image_url === second.image_url,
  );
  const pricing = body(
    await app.inject({ method: "GET", url: `/checkout/v1/pricing/${biz.publicId}` }),
  ) as { links?: Array<{ id: string; image_url: string | null }> };
  ok(
    "image: the pricing page card shows it",
    !!pricing.links?.some((l) => l.id === link.id && l.image_url === second.image_url),
  );
  await clearPublicRateLimits();
  const visit = body(await open(link.id));
  const view = body(await buyer("/checkout/v1/session", visit.token));
  ok(
    "image: the checkout line and the offer line show it",
    view.items?.[0]?.image_url === second.image_url &&
      view.offer?.lines?.[0]?.image_url === second.image_url,
  );
  const patched = await op("PATCH", `/products/${pack.publicId}`, {
    image_url: "https://example.com/elsewhere.png",
  });
  ok(
    "image: a request body cannot point it somewhere else",
    patched.statusCode === 400 &&
      body(await op("GET", `/products/${pack.publicId}`)).image_url === second.image_url,
  );
  const removed = await op("DELETE", `/products/${pack.publicId}/image`);
  ok(
    "image: DELETE clears it and deletes the file",
    removed.statusCode === 200 && body(removed).image_url === null && deletedKeys.length === 2,
  );
}
setObjectStoreDriverForTests(null);

// ── Product redirect URL ──────────────────────────────────────────────────────
// The after-payment page when the checkout or link names none of its own.
ok(
  "redirect: a javascript: URL is refused (400)",
  (await op("PATCH", `/products/${pack.publicId}`, { redirect_url: "javascript:alert(1)" }))
    .statusCode === 400,
);
ok(
  "redirect: an https URL is saved",
  body(
    await op("PATCH", `/products/${pack.publicId}`, {
      redirect_url: "https://shop.example.com/thanks",
    }),
  ).redirect_url === "https://shop.example.com/thanks",
);
await clearPublicRateLimits();
const fallback = body(await buyer("/checkout/v1/session", body(await open(link.id)).token));
ok(
  "redirect: a link with none of its own sends the buyer to the product's page",
  fallback.redirect_url === "https://shop.example.com/thanks",
);
const ownLink = body(
  await op("POST", "/payment_links", {
    name: "Own redirect",
    items: [{ price: packUsd.publicId }],
    redirect_url: "https://shop.example.com/link-thanks",
  }),
);
const own = body(await buyer("/checkout/v1/session", body(await open(ownLink.id)).token));
ok(
  "redirect: the link's own page wins",
  own.redirect_url === "https://shop.example.com/link-thanks",
);
await op("PATCH", `/products/${pack.publicId}`, { redirect_url: "" });
await clearPublicRateLimits();

// ── Rate limit ────────────────────────────────────────────────────────────────
await clearPublicRateLimits();
let limited = false;
for (let i = 0; i < 10 && !limited; i++) limited = (await open(link.id)).statusCode === 429;
ok("rate limit: repeated opens from one address get 429", limited);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);
