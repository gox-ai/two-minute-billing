/**
 * verify:storefront-analytics — first-party, cookie-free visit tracking for checkout and portal.
 *
 * Records events through the real `/checkout/v1/visits` and `/portal/v1/visits` routes for two
 * organizations and reads them back: attribution is first touch and keeps only the referrer
 * host, a page that never ran is not a view, GPC/DNT and bots write nothing, no IP address or
 * full user agent reaches the table, the reports add up (channel, country, device, browser,
 * step time, conversion and revenue; portal sections and PDF downloads) through the real
 * checkout_report and portal_report routes, the country and device filters narrow them,
 * one tenant never sees another's rows, the rate limit holds and the sweep keeps 13 months.
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import {
  STOREFRONT_VISIT_RETENTION_MS,
  sweepStorefrontVisits,
} from "@/modules/storefront-analytics/retention";
import { STOREFRONT_VISIT_RATE_PER_SESSION } from "@/api/storefront-visit-routes";
import { checkoutSessions, invoices, storefrontVisits } from "@db/schema";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const app = await buildApp({ logger: false });
await clearPublicRateLimits();

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const UA_TABLET =
  "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const IP = "203.0.113.77";

async function tenant(name: string) {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: `${name} Biz`,
    defaultCurrency: "USD",
    livemode: "test",
    timezone: "UTC",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  return { org, orgId, biz, price };
}
const A = await tenant("Visits A");
const B = await tenant("Visits B");

const json = (r: { body: string }) => (r.body ? JSON.parse(r.body) : {});
const mint = async (t: typeof A) => {
  const r = await app.inject({
    method: "POST",
    url: `/v1/businesses/${t.biz.publicId}/checkout_sessions`,
    headers: { authorization: `Bearer ${t.org.secret}`, "idempotency-key": crypto.randomUUID() },
    payload: { price: t.price.publicId },
  });
  return json(r) as { token: string; id: string };
};
const visit = (
  surface: "checkout" | "portal",
  token: string,
  payload: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url: `/${surface}/v1/visits`,
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": UA_DESKTOP,
      "x-forwarded-for": IP,
      ...headers,
    },
    payload,
  });
const call = (path: string, token: string, payload: object) =>
  app.inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() },
    payload,
  });
const rowOf = async (session: string) =>
  (
    await systemDb
      .select()
      .from(storefrontVisits)
      .where(eq(storefrontVisits.sessionPublicId, session))
  )[0];

// ── Checkout: organic search, desktop, US; completes ─────────────────────────
const s1 = await mint(A);
let r = await visit(
  "checkout",
  s1.token,
  { kind: "entry", referrer_host: "https://www.google.com/search?q=secret-term" },
  { "cf-ipcountry": "US" },
);
ok("entry answers 204", r.statusCode === 204, r.body);
let row = await rowOf(s1.id);
ok("entry keeps only the referrer host", row?.referrerHost === "google.com", row?.referrerHost);
ok("entry alone is not a view", row?.viewedAt === null && row?.enteredAt instanceof Date);
ok(
  "device, browser, OS and country come from the request",
  row?.deviceCategory === "desktop" &&
    row.browser === "Chrome" &&
    row.os === "Windows" &&
    row.country === "US",
  row,
);
await visit("checkout", s1.token, { kind: "view" }, { "cf-ipcountry": "US" });
await visit("checkout", s1.token, { kind: "engage", steps: { details: 5000, bogus: 99 } });
await visit("checkout", s1.token, { kind: "engage", steps: { details: 1000 } });
row = await rowOf(s1.id);
ok("view stamps viewed_at", row?.viewedAt instanceof Date);
ok(
  "engage adds time per step and drops unknown keys",
  row?.stepMs.details === 6000 && !("bogus" in (row?.stepMs ?? {})) && row?.engagedMs === 6000,
  row?.stepMs,
);
// A second entry (a reminder link) keeps the first touch.
await visit("checkout", s1.token, { kind: "entry", utm_source: "later", utm_medium: "email" });
row = await rowOf(s1.id);
ok(
  "attribution is first touch",
  row?.referrerHost === "google.com" && row?.utmSource === null,
  row,
);

await call("/checkout/v1/customer", s1.token, {
  email: "visits-a@example.com",
  address: {
    line1: "1 Visit St",
    city: "San Francisco",
    state: "California",
    state_code: "CA",
    postal_code: "94105",
    country: "US",
    first_name: "Vis",
    last_name: "It",
  },
});
const done = await call("/checkout/v1/complete", s1.token, { token: "tok_4242" });
ok("checkout completes", done.statusCode === 201, done.body);

// ── Checkout: email campaign, phone, India ───────────────────────────────────
const s2 = await mint(A);
await visit(
  "checkout",
  s2.token,
  { kind: "entry", utm_source: "Newsletter", utm_medium: "email", utm_campaign: "nov-digest" },
  { "user-agent": UA_IPHONE, "cf-ipcountry": "IN" },
);
await visit(
  "checkout",
  s2.token,
  { kind: "view" },
  { "user-agent": UA_IPHONE, "cf-ipcountry": "IN" },
);
await visit(
  "checkout",
  s2.token,
  { kind: "engage", steps: { details: 2000, card: 3000 } },
  { "user-agent": UA_IPHONE },
);

// ── Opened by a link scanner only: entry, never viewed ───────────────────────
const s3 = await mint(A);
await visit("checkout", s3.token, { kind: "entry", referrer_host: "partner.example.com" });

// ── Privacy: GPC, DNT and bots write nothing ─────────────────────────────────
const s4 = await mint(A);
r = await visit("checkout", s4.token, { kind: "entry" }, { "sec-gpc": "1" });
ok("a GPC request answers 204", r.statusCode === 204);
await visit("checkout", s4.token, { kind: "view" }, { dnt: "1" });
await visit("checkout", s4.token, { kind: "view" }, { "user-agent": UA_BOT });
await visit("checkout", s4.token, { kind: "view" }, { "user-agent": "" });
ok("GPC, DNT, a bot and no user agent record nothing", (await rowOf(s4.id)) === undefined);

// ── Refusals ─────────────────────────────────────────────────────────────────
ok(
  "an unknown kind is refused (400)",
  (await visit("checkout", s2.token, { kind: "steal" })).statusCode === 400,
);
ok(
  "no token is refused (401)",
  (
    await app.inject({
      method: "POST",
      url: "/checkout/v1/visits",
      payload: { kind: "view" },
    })
  ).statusCode === 401,
);
ok(
  "a body over 2 KB is refused",
  (
    await visit("checkout", s2.token, {
      kind: "entry",
      utm_source: "x".repeat(150),
      utm_medium: "y".repeat(150),
      utm_campaign: "z".repeat(150),
      referrer_host: "h".repeat(250),
      pad: "p".repeat(2000),
    })
  ).statusCode >= 400,
);

// ── Portal ───────────────────────────────────────────────────────────────────
const customer = await createCustomer({
  organizationId: A.orgId,
  businessId: A.biz.id,
  email: "visits-portal@example.com",
});
const portal = await createPortalSession({
  organizationId: A.orgId,
  businessId: A.biz.id,
  customerId: customer.id,
});
const exchanged = await app.inject({
  method: "POST",
  url: "/portal/v1/session",
  headers: { authorization: `Bearer ${portal.accessToken}` },
});
const psst = String(json(exchanged).token ?? "");
const ph = { "user-agent": UA_TABLET, "cf-ipcountry": "GB" };
await visit("portal", psst, { kind: "view" }, ph);
await visit("portal", psst, { kind: "engage", steps: { invoices: 4000, plan: 500 } }, ph);
await visit("portal", psst, { kind: "pdf" }, ph);
await visit("portal", psst, { kind: "pdf" }, ph);
const prow = await rowOf(portal.publicId);
ok(
  "portal row is keyed to the portal session",
  prow?.surface === "portal" && prow.portalSessionId !== null && prow.checkoutSessionId === null,
);
ok(
  "a checkout token is refused on the portal route (401)",
  (await visit("portal", s2.token, { kind: "view" })).statusCode === 401,
);

// ── Business B (another organization) ────────────────────────────────────────
const b1 = await mint(B);
await visit("checkout", b1.token, { kind: "view" }, { "cf-ipcountry": "DE" });

// ── Nothing identifying is stored ────────────────────────────────────────────
const cols = (await systemDb.execute(sql`
  select column_name from information_schema.columns where table_name = 'storefront_visits'`)) as unknown as Array<{
  column_name: string;
}>;
ok(
  "the table has no IP or user-agent column",
  !cols.some((c) => /ip|user_agent|ua$/.test(c.column_name)),
  cols,
);
const dump = (
  (await systemDb.execute(
    sql`select row_to_json(v)::text as j from storefront_visits v`,
  )) as unknown as Array<{
    j: string;
  }>
)
  .map((x) => x.j)
  .join("\n");
ok("no stored row holds the IP address", !dump.includes(IP));
ok(
  "no stored row holds a full user agent",
  ![UA_DESKTOP, UA_IPHONE, UA_TABLET].some((u) => dump.includes(u)) && !dump.includes("Mozilla"),
);
ok("no stored row holds a referrer path or query", !dump.includes("secret-term"));

// ── Reports, through the real report routes ─────────────────────────────────
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
type Tracked = {
  key: string | null;
  views: number;
  completed: number;
  conversion_bps: number | null;
  revenue_minor: number;
};
type CheckoutReportBody = {
  totals: { opened: number; completed: number };
  options: { countries: string[]; devices: string[] };
  tracking: {
    since: string | null;
    views: number;
    completed: number;
    channels: Array<
      Tracked & { channel: string; source: string; medium: string; campaign: string | null }
    >;
    countries: Tracked[];
    devices: Tracked[];
    browsers: Tracked[];
    step_time: Array<{ step: string; visits: number; median_ms: number }>;
  };
};
type PortalReportBody = {
  totals: { visits: number };
  tracking: {
    since: string | null;
    visits: number;
    sections: Array<{ section: string; visits: number }>;
    countries: Array<{ key: string | null; visits: number }>;
    devices: Array<{ key: string | null; visits: number }>;
    pdf_downloads: number;
    visits_with_pdf: number;
  };
};
const report = async <T>(
  t: typeof A,
  bizPublicId: string,
  kind: "checkout_report" | "portal_report",
  q: Record<string, string> = {},
) => {
  const qs = new URLSearchParams({ start: day(-1), end: day(1), ...q });
  const res = await app.inject({
    method: "GET",
    url: `/v1/businesses/${bizPublicId}/${kind}?${qs}`,
    headers: { authorization: `Bearer ${t.org.secret}` },
  });
  return { status: res.statusCode, body: json(res) as T };
};

// The page's own "viewed" stamp, so the report's existing figures have sessions to filter.
for (const s of [s1, s2])
  await app.inject({
    method: "POST",
    url: "/checkout/v1/viewed",
    headers: { authorization: `Bearer ${s.token}`, "idempotency-key": crypto.randomUUID() },
    payload: { layout: "steps", device_class: "desktop" },
  });

const ctRes = await report<CheckoutReportBody>(A, A.biz.publicId, "checkout_report");
ok("the checkout report answers 200", ctRes.status === 200, ctRes.body);
const ct = ctRes.body.tracking;
const [s1Row] = await withTenant(A.orgId, (tx) =>
  tx.select().from(checkoutSessions).where(eq(checkoutSessions.publicId, s1.id)),
);
const paid = s1Row?.resultingSubscriptionId
  ? await withTenant(A.orgId, (tx) =>
      tx
        .select({ total: invoices.totalMinor })
        .from(invoices)
        .where(
          and(
            eq(invoices.subscriptionId, s1Row.resultingSubscriptionId!),
            eq(invoices.status, "paid"),
          ),
        ),
    )
  : [];
const revenue = Number(paid[0]?.total ?? -1);
ok(
  "tracking: two views (the scanner is not one), one completed",
  ct?.views === 2 && ct.completed === 1,
  ct,
);
const organic = ct?.channels.find((c) => c.channel === "Organic search");
const email = ct?.channels.find((c) => c.channel === "Email");
ok(
  "channel: organic search from google.com converted, with the paid invoice as revenue",
  revenue > 0 &&
    organic?.source === "google.com" &&
    organic.medium === "organic" &&
    organic.views === 1 &&
    organic.completed === 1 &&
    organic.conversion_bps === 10000 &&
    organic.revenue_minor === revenue,
  { organic, revenue },
);
ok(
  "channel: email newsletter campaign",
  email?.source === "newsletter" &&
    email.medium === "email" &&
    email.campaign === "nov-digest" &&
    email.views === 1 &&
    email.completed === 0,
  email,
);
ok(
  "visitor countries, devices and browsers",
  ct?.countries
    .map((c) => c.key)
    .sort()
    .join() === "IN,US" &&
    ct.countries.find((c) => c.key === "US")?.conversion_bps === 10000 &&
    ct.devices.find((d) => d.key === "desktop")?.completed === 1 &&
    ct.devices.find((d) => d.key === "mobile")?.views === 1 &&
    ct.browsers
      .map((b) => b.key)
      .sort()
      .join() === "Chrome,Safari",
  ct && { c: ct.countries, d: ct.devices, b: ct.browsers },
);
const details = ct?.step_time.find((s) => s.step === "details");
ok(
  "median time on the details step",
  details?.visits === 2 && details.median_ms === 4000,
  ct?.step_time,
);
ok("tracking.since is set", ct?.since != null);
ok(
  "the country filter lists tracked countries",
  ctRes.body.options.countries.slice().sort().join() === "IN,US" &&
    ctRes.body.options.devices.join() === "desktop,mobile,tablet",
  ctRes.body.options,
);
const us = (
  await report<CheckoutReportBody>(A, A.biz.publicId, "checkout_report", { country: "us" })
).body;
const mobile = (
  await report<CheckoutReportBody>(A, A.biz.publicId, "checkout_report", { device: "mobile" })
).body;
ok(
  "country and device filters narrow tracking and the existing figures",
  us.tracking.views === 1 &&
    us.tracking.completed === 1 &&
    us.totals.opened === 1 &&
    us.totals.completed === 1 &&
    mobile.tracking.views === 1 &&
    mobile.totals.opened === 1 &&
    mobile.totals.completed === 0,
  { us: [us.totals, us.tracking.views], mobile: [mobile.totals, mobile.tracking.views] },
);
ok(
  "a bad country or device is refused (400)",
  (await report(A, A.biz.publicId, "checkout_report", { country: "USA" })).status === 400 &&
    (await report(A, A.biz.publicId, "portal_report", { device: "watch" })).status === 400,
);
const past = (
  await report<CheckoutReportBody>(A, A.biz.publicId, "checkout_report", {
    start: day(-30),
    end: day(-10),
  })
).body;
ok(
  "a range before tracking has no views",
  past.tracking.views === 0 && past.tracking.since !== null,
);

const ptRes = await report<PortalReportBody>(A, A.biz.publicId, "portal_report");
const pt = ptRes.body.tracking;
ok(
  "portal: one visit, two PDF downloads",
  ptRes.status === 200 && pt?.visits === 1 && pt.pdf_downloads === 2 && pt.visits_with_pdf === 1,
  ptRes.body,
);
ok(
  "portal: a section counts after a second on screen",
  pt?.sections.length === 1 && pt.sections[0]?.section === "invoices",
  pt?.sections,
);
ok(
  "portal: country and device",
  pt?.countries[0]?.key === "GB" && pt.devices[0]?.key === "tablet",
  pt && { c: pt.countries, d: pt.devices },
);
const gb = (await report<PortalReportBody>(A, A.biz.publicId, "portal_report", { country: "GB" }))
  .body;
const usPortal = (
  await report<PortalReportBody>(A, A.biz.publicId, "portal_report", { country: "US" })
).body;
ok(
  "portal: the country filter narrows visits",
  gb.totals.visits === 1 && gb.tracking.visits === 1 && usPortal.totals.visits === 0,
  { gb: gb.totals, us: usPortal.totals },
);

// ── Tenant isolation ─────────────────────────────────────────────────────────
const ctB = (await report<CheckoutReportBody>(B, B.biz.publicId, "checkout_report")).body;
ok(
  "business B sees only its own view",
  ctB.tracking.views === 1 && ctB.tracking.countries[0]?.key === "DE",
  ctB.tracking,
);
ok(
  "organization A cannot read business B's report",
  (await report(A, B.biz.publicId, "checkout_report")).status >= 400,
);
const rlsRows = await withTenant(A.orgId, (tx) =>
  tx.select().from(storefrontVisits).where(eq(storefrontVisits.businessId, B.biz.id)),
);
ok("RLS hides another organization's rows", rlsRows.length === 0);

// ── Rate limit ───────────────────────────────────────────────────────────────
const s5 = await mint(A);
// The window is a fixed minute: a run that crosses its edge starts counting again, so send
// up to two windows' worth and stop at the first refusal.
let last = 0;
for (let i = 0; i <= 2 * STOREFRONT_VISIT_RATE_PER_SESSION + 1 && last !== 429; i++)
  last = (await visit("checkout", s5.token, { kind: "view" })).statusCode;
ok("the per-session rate limit holds (429)", last === 429, last);

// ── Retention ────────────────────────────────────────────────────────────────
await systemDb
  .update(storefrontVisits)
  .set({ createdAt: new Date(Date.now() - STOREFRONT_VISIT_RETENTION_MS - 86_400_000) })
  .where(eq(storefrontVisits.sessionPublicId, s3.id));
const swept = await sweepStorefrontVisits(new Date());
ok(
  "the sweep deletes visits older than 13 months, and only those",
  swept.deleted >= 1 && (await rowOf(s3.id)) === undefined && (await rowOf(s2.id)) !== undefined,
);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail === 0 ? 0 : 1);
