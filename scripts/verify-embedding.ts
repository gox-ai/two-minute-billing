/**
 * Embedded checkout and portal, engine half (Phase 1): one list of allowed websites per business
 * (shared with the usage widget), `embed_origin` on checkout and portal sessions checked against
 * it, and the frame-ancestor lookup the storefront makes before a page may be framed. Removing a
 * website stops its embeds at once; another business's list never counts.
 *
 *   pnpm verify:all:fresh -- --suite embedding
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { createApiKey, createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import {
  CheckoutError,
  createCheckoutSession,
  getCheckoutView,
  resolveCheckoutSession,
} from "@/modules/checkout/service";
import { EMBED_SCRIPT_INTEGRITY } from "@/modules/embedding/embed-script";
import { createHash } from "node:crypto";
import { normaliseEmbedOrigin, resolveFrameAncestor } from "@/modules/embedding/service";
import { businesses } from "@db/schema";
import { checker } from "./lib/meter-fixtures";

const { fails, check } = checker();
const app = await buildApp({ logger: false });

const SITE = "https://app.example.com";
const OTHER = "https://other.example.com";
const LOCAL = "http://localhost:3000";

async function setup(name: string, livemode: "test" | "live" = "test") {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode,
  });
  const ids = { organizationId: orgId, businessId: biz.id };
  const product = await createProduct({ ...ids, name: "Pro" });
  const price = await createPrice({
    ...ids,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const customer = await createCustomer({ ...ids, email: `embed-${Date.now()}@example.com` });
  return { org, orgId, biz, ids, price, customer };
}

let n = 0;
async function op(secret: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": `emb-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const frame = async (credential: string) => {
  const r = await app.inject({
    method: "GET",
    url: `/storefront/v1/frame_ancestor?credential=${encodeURIComponent(credential)}`,
  });
  return { status: r.statusCode, origin: JSON.parse(r.body).frame_ancestor as string | null };
};

const A = await setup("Embed Org A");
const B = await setup("Embed Org B");
const settings = (x: typeof A) => `/v1/businesses/${x.biz.publicId}/settings/embedding`;

// ── 1. Origins ────────────────────────────────────────────────────────────────
console.log("1. origin rules");
check(
  "an https origin is kept",
  (normaliseEmbedOrigin("https://App.Example.com/") as { origin: string }).origin === SITE,
);
check("a path is refused", "error" in normaliseEmbedOrigin("https://app.example.com/billing"));
check(
  "plain http off loopback is refused",
  "error" in normaliseEmbedOrigin("http://app.example.com"),
);
check("plain http on loopback is kept", "origin" in normaliseEmbedOrigin(LOCAL));

// ── 2. The list, shared with the usage widget ─────────────────────────────────
console.log("2. allowed websites");
const bad = await op(A.org.secret, "PUT", settings(A), { origins: [SITE, "ftp://x.example.com"] });
check(
  "an invalid website is refused with its param (400)",
  bad.status === 400 && bad.body?.error?.param === "origins.1",
  bad,
);
const put = await op(A.org.secret, "PUT", settings(A), { origins: [SITE, LOCAL, SITE] });
check(
  "the list saves, normalised and without duplicates",
  put.status === 200 && JSON.stringify(put.body.origins) === JSON.stringify([SITE, LOCAL]),
  put,
);
const get = await op(A.org.secret, "GET", settings(A));
check(
  "GET returns the list",
  JSON.stringify(get.body?.origins) === JSON.stringify([SITE, LOCAL]),
  get,
);
const widget = await op(
  A.org.secret,
  "GET",
  `/v1/businesses/${A.biz.publicId}/settings/usage_widget`,
);
check(
  "the usage widget reads the same list",
  JSON.stringify(widget.body?.origins) === JSON.stringify([SITE, LOCAL]),
  widget,
);
const [row] = await systemDb
  .select({ old: businesses.usageWidgetOrigins })
  .from(businesses)
  .where(eq(businesses.id, A.biz.id));
check(
  "usage_widget_origins is kept in step",
  JSON.stringify(row?.old) === JSON.stringify([SITE, LOCAL]),
  row,
);
const viewer = await createApiKey(A.orgId, "test", "api", "write", "embed view", null, {
  settings: "read",
});
check("settings:view reads the list", (await op(viewer.secret, "GET", settings(A))).status === 200);
check(
  "settings:view cannot change it (403)",
  (await op(viewer.secret, "PUT", settings(A), { origins: [] })).status === 403,
);

// ── 3. Checkout sessions ──────────────────────────────────────────────────────
console.log("3. checkout embed_origin");
const mintCo = (x: typeof A, extra: Record<string, unknown>) =>
  op(x.org.secret, "POST", `/v1/businesses/${x.biz.publicId}/checkout_sessions`, {
    price: x.price.publicId,
    ...extra,
  });
const coOff = await mintCo(A, { embed_origin: OTHER });
check(
  "a website not on the list is refused (400)",
  coOff.status === 400 &&
    /not in this business's allowed websites/.test(coOff.body?.error?.message ?? ""),
  coOff,
);
const coB = await mintCo(B, { embed_origin: SITE });
check("another business's list does not count (400)", coB.status === 400, coB);
const co = await mintCo(A, { embed_origin: "https://APP.example.com" });
check(
  "a listed website is accepted and echoed normalised (201)",
  co.status === 201 && co.body.embed_origin === SITE,
  co,
);
const coGet = await op(
  A.org.secret,
  "GET",
  `/v1/businesses/${A.biz.publicId}/checkout_sessions/${co.body.id}`,
);
check("GET shows the session's embed_origin", coGet.body?.embed_origin === SITE, coGet.body);
const coPlain = await mintCo(A, {});
check(
  "a session without it is hosted only (no embed_origin)",
  coPlain.status === 201 && coPlain.body.embed_origin === undefined,
  coPlain,
);
const coLocal = await mintCo(A, { embed_origin: LOCAL });
check(
  "a loopback website works in a test business",
  coLocal.status === 201 && coLocal.body.embed_origin === LOCAL,
  coLocal,
);
const L = await setup("Embed Org Live", "live");
await systemDb
  .update(businesses)
  .set({ embedOrigins: [LOCAL] })
  .where(eq(businesses.id, L.biz.id));
let liveErr = "";
try {
  await createCheckoutSession({ ...L.ids, priceId: L.price.publicId, embedOrigin: LOCAL });
} catch (e) {
  liveErr = e instanceof CheckoutError ? e.message : String(e);
}
check("a loopback website is refused in a live business", /local address/.test(liveErr), liveErr);

// ── 4. Portal sessions ────────────────────────────────────────────────────────
console.log("4. portal embed_origin");
const portalUrl = (x: typeof A) =>
  `/v1/businesses/${x.biz.publicId}/customers/${x.customer.publicId}/portal_sessions`;
const ps = await op(A.org.secret, "POST", portalUrl(A), { embed_origin: SITE });
check("a listed website is accepted (201)", ps.status === 201 && ps.body.embed_origin === SITE, ps);
const psOff = await op(A.org.secret, "POST", portalUrl(A), { embed_origin: OTHER });
check("a website not on the list is refused (400)", psOff.status === 400, psOff);
const psMail = await op(A.org.secret, "POST", portalUrl(A), {
  embed_origin: SITE,
  link_kind: "email",
});
check("an emailed link cannot be embedded (400)", psMail.status === 400, psMail);
const psGet = await op(A.org.secret, "GET", `${portalUrl(A)}/${ps.body.id}`);
check("GET shows the session's embed_origin", psGet.body?.embed_origin === SITE, psGet.body);
const psPlain = await op(A.org.secret, "POST", portalUrl(A), {});

// ── 5. The frame-ancestor lookup ──────────────────────────────────────────────
console.log("5. frame ancestor");
check("the checkout link token names its website", (await frame(co.body.token)).origin === SITE);
check("the checkout session id names its website", (await frame(co.body.id)).origin === SITE);
check("the portal entry token names its website", (await frame(ps.body.token)).origin === SITE);
check("the portal session id names its website", (await frame(ps.body.id)).origin === SITE);
check("a hosted-only checkout answers null", (await frame(coPlain.body.token)).origin === null);
check("a hosted-only portal answers null", (await frame(psPlain.body.token)).origin === null);
const junk = await frame("cstk_" + "x".repeat(43));
check(
  "an unknown token answers null (200, no oracle)",
  junk.status === 200 && junk.origin === null,
  junk,
);
check("a malformed credential answers null", (await frame("'; drop table x; --")).origin === null);
check(
  "an over-long credential answers null",
  (await frame("cosess_" + "a".repeat(300))).origin === null,
);

// Removing the website stops every embed at once, even though B lists it.
await op(B.org.secret, "PUT", settings(B), { origins: [SITE] });
await op(A.org.secret, "PUT", settings(A), { origins: [LOCAL] });
check(
  "after removal the checkout token answers null",
  (await resolveFrameAncestor(co.body.token)) === null,
);
check(
  "after removal the checkout session id answers null",
  (await resolveFrameAncestor(co.body.id)) === null,
);
check(
  "after removal the portal token answers null",
  (await resolveFrameAncestor(ps.body.token)) === null,
);
check(
  "after removal the portal session id answers null",
  (await resolveFrameAncestor(ps.body.id)) === null,
);
check(
  "a session still on the list keeps its website",
  (await resolveFrameAncestor(coLocal.body.id)) === LOCAL,
);

// ── 6. The loader and the buyer's view (Phase 2) ──────────────────────────────
console.log("6. loader");
const js = await app.inject({ method: "GET", url: "/js/v1/embed.js" });
const hash = `sha384-${createHash("sha384").update(js.body).digest("base64")}`;
check(
  "embed.js is served as JavaScript to any page (CORS *)",
  js.statusCode === 200 &&
    String(js.headers["content-type"]).startsWith("application/javascript") &&
    js.headers["access-control-allow-origin"] === "*",
  js.headers,
);
check("the served bytes match the published integrity hash", hash === EMBED_SCRIPT_INTEGRITY);
const withScript = await op(A.org.secret, "GET", settings(A));
check(
  "the settings carry the script integrity hash",
  withScript.body?.script_integrity === EMBED_SCRIPT_INTEGRITY && "script_url" in withScript.body,
  withScript.body,
);
const ctx = await resolveCheckoutSession(coLocal.body.token);
const view = ctx ? await getCheckoutView(ctx) : null;
check(
  "the buyer's view names the session's embed_origin",
  view?.embed_origin === LOCAL,
  view?.embed_origin,
);
const plainCtx = await resolveCheckoutSession(coPlain.body.token);
const plainView = plainCtx ? await getCheckoutView(plainCtx) : null;
check("a hosted-only view has none", plainView?.embed_origin === null, plainView?.embed_origin);

await app.close();
console.log("");
console.log(fails.length === 0 ? "✅ EMBEDDING: PASS" : `❌ EMBEDDING: FAIL (${fails.join(", ")})`);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
