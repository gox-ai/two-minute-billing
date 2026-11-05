/**
 * Embeddable usage widget (design G5 § 3.9, § 8): the token lives 15 minutes, reads its own
 * customer only, is never usable from its stored hash, opens no write route, and a browser gets
 * the data only from an origin the token's business lists. Minting needs customers:manage.
 *
 *   pnpm verify:all:fresh -- --suite usage-widget
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { config } from "@/platform/config";
import { closeDb, systemDb } from "@/platform/db";
import { createApiKey } from "@/modules/tenancy/service";
import { createSpendLimit } from "@/modules/usage-controls/limits";
import { USAGE_WIDGET_SCRIPT_INTEGRITY } from "@/modules/usage-controls/widget-script";
import { usageWidgetTokens } from "@db/schema";
import { checker, meterBusiness, newCustomer } from "./lib/meter-fixtures";

const { fails, check } = checker();
const A = await meterBusiness("Usage Widget Org A");
const B = await meterBusiness("Usage Widget Org B");
const app = await buildApp({ logger: false });

let n = 0;
async function op(secret: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": `uw-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}
const widget = (
  token: string,
  origin?: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
) =>
  app.inject({
    method,
    url: "/widget/v1/usage",
    headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
  });

/** A customer with one operator limit, so each widget read names whose data it is. */
async function customerWithLimit(biz: typeof A, tag: string, amountMinor: bigint) {
  const c = await newCustomer(biz.ids, tag);
  await createSpendLimit({
    ...biz.ids,
    customerId: c.id,
    fields: {
      scope: "customer",
      interval: "month",
      amountMinor,
      currency: "USD",
      mode: "soft",
      setBy: "operator",
    },
  });
  return c;
}
async function mint(biz: typeof A, secret: string, customerPublicId: string) {
  return op(
    secret,
    "POST",
    `/v1/businesses/${biz.biz.publicId}/customers/${customerPublicId}/usage_widget_tokens`,
  );
}
const limitsOf = (body: { limits?: Array<{ amount_minor: number }> }) =>
  (body.limits ?? []).map((l) => l.amount_minor).sort();

// Minted in this order on purpose: a lookup that ignored the token would return the first row.
const a2 = await customerWithLimit(A, "widget-a2", 2222n);
const b1 = await customerWithLimit(B, "widget-b1", 3333n);
const a1 = await customerWithLimit(A, "widget-a1", 1111n);
const tA2 = await mint(A, A.org.secret, a2.publicId);
const tB1 = await mint(B, B.org.secret, b1.publicId);
const tA1 = await mint(A, A.org.secret, a1.publicId);

// ── 1. Minting needs customers:manage ──────────────────────────────────────────
console.log("1. mint permission");
check(
  "a full key mints a uwt_ token (201)",
  tA1.status === 201 && /^uwt_/.test(tA1.body?.token),
  tA1,
);
const readOnly = await createApiKey(A.orgId, "test", "api", "write", "widget read", null, {
  customers: "read",
  usage_controls: "write",
});
const refused = await mint(A, readOnly.secret, a1.publicId);
check("a key without customers:manage is refused (403)", refused.status === 403, refused);
const minting = await createApiKey(A.orgId, "test", "api", "write", "widget mint", null, {
  customers: "write",
});
const allowed = await mint(A, minting.secret, a1.publicId);
check("a key with customers:manage mints (201)", allowed.status === 201, allowed);

// ── 2. A token reads its own customer only ─────────────────────────────────────
console.log("2. scope");
const rA1 = await widget(tA1.body.token);
const vA1 = JSON.parse(rA1.body);
check("the token reads its customer (200)", rA1.statusCode === 200, rA1.body);
check(
  "it shows that customer's limit only",
  JSON.stringify(limitsOf(vA1)) === JSON.stringify([1111]),
  limitsOf(vA1),
);
const vB1 = JSON.parse((await widget(tB1.body.token)).body);
check(
  "business B's token shows B's customer",
  JSON.stringify(limitsOf(vB1)) === "[3333]",
  limitsOf(vB1),
);
check(
  "A's token never shows B's or another A customer's data",
  !limitsOf(vA1).includes(3333) && !limitsOf(vA1).includes(2222),
);
const otherBiz = await mint(A, A.org.secret, b1.publicId);
check("A cannot mint for B's customer (404)", otherBiz.status === 404, otherBiz);

// ── 3. The stored hash is not a token ──────────────────────────────────────────
console.log("3. stored hash");
const [row] = await systemDb
  .select()
  .from(usageWidgetTokens)
  .where(eq(usageWidgetTokens.customerId, a1.id))
  .limit(1);
check(
  "only a hash is stored",
  !!row && row.tokenHash !== tA1.body.token && !row.tokenHash.startsWith("uwt_"),
);
const byHash = await widget(row!.tokenHash);
const byPrefixedHash = await widget(`uwt_${row!.tokenHash}`);
check(
  "the stored value does not authenticate (401)",
  byHash.statusCode === 401 && byPrefixedHash.statusCode === 401,
  [byHash.statusCode, byPrefixedHash.statusCode],
);

// ── 4. 15 minutes ──────────────────────────────────────────────────────────────
console.log("4. expiry");
const ttl = Date.parse(tA1.body.expires_at) - Date.now();
check("expires_at is 15 minutes out", ttl > 14.9 * 60_000 && ttl <= 15 * 60_000, ttl);
await systemDb
  .update(usageWidgetTokens)
  .set({ expiresAt: new Date(Date.now() - 1000) })
  .where(eq(usageWidgetTokens.customerId, a2.id));
const expired = await widget(tA2.body.token);
check("an expired token is refused (401)", expired.statusCode === 401, expired.statusCode);

// ── 5. Read-only ───────────────────────────────────────────────────────────────
console.log("5. read-only");
for (const m of ["POST", "PUT", "PATCH", "DELETE"] as const) {
  const r = await widget(tA1.body.token, undefined, m);
  check(`${m} /widget/v1/usage has no route`, r.statusCode === 404, r.statusCode);
}
for (const [m, url] of [
  ["GET", `/v1/businesses/${A.biz.publicId}/customers`],
  ["POST", `/v1/businesses/${A.biz.publicId}/customers/${a1.publicId}/usage_widget_tokens`],
  ["PUT", `/v1/businesses/${A.biz.publicId}/settings/usage_widget`],
] as const) {
  const r = await op(tA1.body.token, m, url, m === "GET" ? undefined : { origins: [] });
  check(
    `a widget token cannot call ${m} ${url.split("/").slice(-1)[0]} (401)`,
    r.status === 401,
    r.status,
  );
}

// ── 6. CORS per business ───────────────────────────────────────────────────────
console.log("6. CORS");
const bad = await op(
  A.org.secret,
  "PUT",
  `/v1/businesses/${A.biz.publicId}/settings/usage_widget`,
  {
    origins: ["http://app.example.com"],
  },
);
check(
  "an http origin is refused (400)",
  bad.status === 400 && bad.body?.error?.param === "origins.0",
  bad,
);
const setA = await op(
  A.org.secret,
  "PUT",
  `/v1/businesses/${A.biz.publicId}/settings/usage_widget`,
  {
    origins: ["https://app.example.com/"],
  },
);
check(
  "the origin is saved normalised, with the script hash",
  setA.status === 200 &&
    JSON.stringify(setA.body.origins) === '["https://app.example.com"]' &&
    setA.body.script_integrity === USAGE_WIDGET_SCRIPT_INTEGRITY,
  setA,
);
await op(B.org.secret, "PUT", `/v1/businesses/${B.biz.publicId}/settings/usage_widget`, {
  origins: ["https://b-app.example.com"],
});
const listed = await widget(tA1.body.token, "https://app.example.com");
check(
  "a listed origin is granted",
  listed.headers["access-control-allow-origin"] === "https://app.example.com",
  listed.headers,
);
const unlisted = await widget(tA1.body.token, "https://evil.example.com");
check(
  "an unlisted origin gets no grant",
  unlisted.headers["access-control-allow-origin"] === undefined,
  unlisted.headers["access-control-allow-origin"],
);
// Our own dashboard origin gets a grant from the global CORS hook on every other route;
// here the business's list alone decides, and it does not list it.
const firstParty = new URL(config.DASHBOARD_BASE_URL ?? "http://localhost:4100").origin;
const ownSite = await widget(tA1.body.token, firstParty);
check(
  "our own dashboard origin gets no grant unless the business lists it",
  ownSite.headers["access-control-allow-origin"] === undefined,
  ownSite.headers["access-control-allow-origin"],
);
const othersOrigin = await widget(tA1.body.token, "https://b-app.example.com");
check(
  "another business's origin gets no grant for A's token",
  othersOrigin.headers["access-control-allow-origin"] === undefined,
  othersOrigin.headers["access-control-allow-origin"],
);
const preflight = (origin: string) =>
  app.inject({
    method: "OPTIONS",
    url: "/widget/v1/usage",
    headers: { origin, "access-control-request-method": "GET" },
  });
const pfOk = await preflight("https://app.example.com");
const pfBad = await preflight("https://evil.example.com");
check(
  "the preflight answers a listed origin and not an unlisted one",
  pfOk.statusCode === 204 &&
    pfOk.headers["access-control-allow-methods"] === "GET" &&
    pfBad.headers["access-control-allow-origin"] === undefined,
  [pfOk.statusCode, pfBad.statusCode],
);
const script = await app.inject({ method: "GET", url: "/widget/v1/usage.js" });
check(
  "the script is served as JavaScript",
  script.statusCode === 200 &&
    String(script.headers["content-type"]).startsWith("application/javascript"),
  script.headers["content-type"],
);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ USAGE WIDGET: PASS" : `❌ USAGE WIDGET: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
