/**
 * verify:address-field-rules — configurable address requiredness on checkout and the buyer
 * portal (0334), end to end through the HTTP routes.
 *
 * Proves: defaults are unchanged; `show` makes a field optional; a hidden or read-only
 * portal key keeps the stored value; the region is one pair; country cannot be hidden; the
 * tax guard refuses a save AND forces the key at runtime; `billing_details_complete`
 * follows the effective config; the 0334 data step rewrites old stored values.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCheckoutSession } from "@/modules/checkout/service";
import { createCustomer } from "@/modules/customers/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { createFlatTaxRate, configureIndiaGst } from "@/modules/tax/service";
import { clearPublicRateLimits } from "./lib/rate-limit-reset";
import { businesses, customers } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
}

type Res = { statusCode: number; payload: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Res): any => {
  try {
    return JSON.parse(r.payload);
  } catch {
    return {};
  }
};
const show = (r: Res) => `${r.statusCode} ${r.payload.slice(0, 300)}`;

const app = await buildApp({ logger: false });
await clearPublicRateLimits();

const org = await createOrganization({ name: "Address Rules Co" });
const orgId = org.organization.id;
const secret = org.secret;

async function newBusiness(name: string, currency = "USD") {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: currency,
    livemode: "test",
  });
  await createGatewayAccount({
    organizationId: orgId,
    businessId: biz.id,
    gatewayKey: "tmtest",
    label: "TM Test",
    credentials: {},
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor: 5000,
    interval: "month",
  });
  return { biz, price };
}

const req = (method: "GET" | "POST" | "PATCH", url: string, token: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  }) as unknown as Promise<Res>;

const patchBiz = (bizPid: string, body: unknown) =>
  req("PATCH", `/v1/businesses/${bizPid}`, secret, body);
const getBiz = (bizPid: string) => req("GET", `/v1/businesses/${bizPid}`, secret);

async function checkoutToken(businessId: string, pricePid: string) {
  const s = await createCheckoutSession({
    organizationId: orgId,
    businessId,
    priceId: pricePid,
    quantity: 1,
  });
  return s.token;
}
const postCheckoutCustomer = (token: string, address: Record<string, string>) =>
  req("POST", "/checkout/v1/customer", token, { email: "buyer@example.com", address });

async function portalToken(businessId: string, customerId: string) {
  const link = await createPortalSession({ organizationId: orgId, businessId, customerId });
  const ex = (await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${link.accessToken}` },
  })) as unknown as Res;
  return String(json(ex).token ?? "");
}

const setStored = (businessId: string, set: Partial<typeof businesses.$inferInsert>) =>
  withTenant(orgId, (tx) => tx.update(businesses).set(set).where(eq(businesses.id, businessId)));

const US = {
  line1: "1 Main St",
  city: "Austin",
  state_code: "TX",
  postal_code: "78701",
  country: "US",
};

// ── A. Defaults unchanged ────────────────────────────────────────────────────
const plain = await newBusiness("Plain");
{
  const g = json(await getBiz(plain.biz.publicId));
  ok(
    "GET business: resolved portal_field_config with every key, defaults",
    g.portal_field_config?.["billing.line1"] === "mandatory" &&
      g.portal_field_config?.["customer.first_name"] === "mandatory" &&
      g.portal_field_config?.["customer.phone"] === "mandatory" &&
      g.portal_field_config?.["billing.line2"] === "show" &&
      Object.keys(g.portal_field_config ?? {}).length === 13,
    JSON.stringify(g.portal_field_config),
  );
  ok(
    "GET business: no tax → address_field_locks both false",
    g.address_field_locks?.country === false && g.address_field_locks?.state_code === false,
    JSON.stringify(g.address_field_locks),
  );

  const tok = await checkoutToken(plain.biz.id, plain.price.publicId);
  const noCity = await postCheckoutCustomer(tok, { line1: "1 Main St", country: "US" });
  const det = JSON.stringify(json(noCity).error?.details ?? {});
  ok(
    "checkout defaults: city, state and ZIP still required for a US address",
    noCity.statusCode === 400 &&
      /City is required/.test(det) &&
      /required for United States/.test(det),
    show(noCity),
  );
  const noLine1 = await postCheckoutCustomer(tok, { ...US, line1: "" });
  ok("checkout defaults: line1 still required", noLine1.statusCode === 400, show(noLine1));
  const full = await postCheckoutCustomer(tok, { ...US, first_name: "Pat" });
  ok("checkout defaults: a complete address is accepted", full.statusCode === 200, show(full));
  ok(
    "checkout defaults: billing_details_complete as before",
    json(full).billing_details_complete === true,
    show(full),
  );
}

// ── B. `show` makes city optional on checkout ────────────────────────────────
{
  const r = await patchBiz(plain.biz.publicId, {
    checkout_field_config: { "billing.city": "show" },
  });
  ok("PATCH: checkout billing.city → show accepted", r.statusCode === 200, show(r));
  const tok = await checkoutToken(plain.biz.id, plain.price.publicId);
  const { city: _c, ...noCity } = US;
  const res = await postCheckoutCustomer(tok, noCity);
  ok("checkout: optional city may be blank", res.statusCode === 200, show(res));
  await setStored(plain.biz.id, { checkoutFieldConfig: null });
}

// ── C. Country cannot be hidden ──────────────────────────────────────────────
{
  const c = await patchBiz(plain.biz.publicId, {
    checkout_field_config: { "billing.country": "hide" },
  });
  const p = await patchBiz(plain.biz.publicId, {
    portal_field_config: { "billing.country": "hide" },
  });
  ok(
    "PATCH: checkout billing.country = hide → 400",
    c.statusCode === 400 && /cannot be hidden/.test(json(c).error?.message ?? ""),
    show(c),
  );
  ok("PATCH: portal billing.country = hide → 400", p.statusCode === 400, show(p));
}

// ── D. Portal: defaults, hidden/read-only keep stored, region pair ───────────
{
  const cus = await createCustomer({
    organizationId: orgId,
    businessId: plain.biz.id,
    email: "portal-rules@example.com",
    address: {
      line1: "1 Old St",
      line2: "Suite 9",
      city: "Austin",
      state: "Texas",
      stateCode: "TX",
      postalCode: "78701",
      country: "US",
      firstName: "Pat",
      lastName: "Stored",
      phone: "+15125550100",
    },
  });
  const tok = await portalToken(plain.biz.id, cus.id);
  const base = {
    ...US,
    line1: "1 Old St",
    first_name: "Pat",
    last_name: "Stored",
    phone: "+15125550100",
  };
  const patchMe = (address: Record<string, string | null>) =>
    req("PATCH", "/portal/v1/me", tok, { address });

  const noPhone = await patchMe({ ...base, phone: null });
  ok("portal defaults: phone required", noPhone.statusCode === 400, show(noPhone));
  const noFirst = await patchMe({ ...base, first_name: null, company: "Acme" });
  ok("portal defaults: first name required", noFirst.statusCode === 400, show(noFirst));
  const noCity = await patchMe({ ...base, city: null });
  ok("portal defaults: city required", noCity.statusCode === 400, show(noCity));

  const me = json(await req("GET", "/portal/v1/me", tok));
  ok(
    "portal payload carries field_config and address_field_locks",
    me.field_config?.["billing.line1"] === "mandatory" && me.address_field_locks?.country === false,
    JSON.stringify({ f: me.field_config, l: me.address_field_locks }),
  );

  let r = await patchBiz(plain.biz.publicId, {
    portal_field_config: {
      "billing.line2": "hide",
      "billing.line1": "read_only",
      "billing.state": "read_only",
    },
  });
  ok("PATCH: portal hide/read_only accepted", r.statusCode === 200, show(r));
  ok(
    "PATCH response: resolved portal_field_config",
    json(r).portal_field_config?.["billing.line1"] === "read_only" &&
      json(r).portal_field_config?.["billing.city"] === "mandatory",
    show(r),
  );

  r = await patchMe({
    ...base,
    line1: "999 Changed Rd",
    line2: "Changed",
    city: "Sacramento",
    state_code: "CA",
    postal_code: "95814",
  });
  ok("portal: save with hidden/read-only keys succeeds", r.statusCode === 200, show(r));
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(customers).where(eq(customers.id, cus.id)).limit(1),
  );
  ok(
    "portal: hidden line2 keeps the stored value",
    row?.addressLine2 === "Suite 9",
    String(row?.addressLine2),
  );
  ok(
    "portal: read-only line1 cannot be changed through the API",
    row?.addressLine1 === "1 Old St",
    String(row?.addressLine1),
  );
  ok("portal: editable city changed", row?.city === "Sacramento", String(row?.city));
  ok(
    "portal: editable state_code moves the state name with it (no stored name next to a new code)",
    row?.stateCode === "CA" && row?.state === "California",
    `${row?.state}/${row?.stateCode}`,
  );

  // billing_details_complete follows the effective config.
  await setStored(plain.biz.id, {
    portalFieldConfig: { "billing.line1": "hide" },
  });
  await withTenant(orgId, (tx) =>
    tx.update(customers).set({ addressLine1: null }).where(eq(customers.id, cus.id)),
  );
  const me2 = json(await req("GET", "/portal/v1/me", tok));
  ok(
    "portal: a hidden line1 does not block billing_details_complete",
    me2.customer?.billing_details_complete === true,
    JSON.stringify(me2.customer),
  );
  await setStored(plain.biz.id, { portalFieldConfig: null });
  const me3 = json(await req("GET", "/portal/v1/me", tok));
  ok(
    "portal: a required, empty line1 still blocks it",
    me3.customer?.billing_details_complete === false,
    JSON.stringify(me3.customer),
  );
}

// ── E. Tax guard: any region locks country ───────────────────────────────────
const taxed = await newBusiness("Taxed");
await createFlatTaxRate({
  organizationId: orgId,
  businessId: taxed.biz.id,
  name: "Sales tax",
  country: "US",
  state: "TX",
  rateBps: 825,
});
{
  const g = json(await getBiz(taxed.biz.publicId));
  ok(
    "GET business: tax region → address_field_locks.country true",
    g.address_field_locks?.country === true && g.address_field_locks?.state_code === false,
    JSON.stringify(g.address_field_locks),
  );
  const c = await patchBiz(taxed.biz.publicId, {
    checkout_field_config: { "billing.country": "show" },
  });
  ok(
    "PATCH: checkout country → show refused while tax is set up",
    c.statusCode === 400 &&
      json(c).error?.message === "Billing country must stay required while tax is set up.",
    show(c),
  );
  const p = await patchBiz(taxed.biz.publicId, {
    portal_field_config: { "billing.country": "read_only" },
  });
  ok(
    "PATCH: portal country → read_only refused while tax is set up",
    p.statusCode === 400,
    show(p),
  );

  // Runtime: a stored "show" (saved before tax existed) is forced back to mandatory.
  await setStored(taxed.biz.id, { checkoutFieldConfig: { "billing.country": "show" } });
  const tok = await checkoutToken(taxed.biz.id, taxed.price.publicId);
  const noCountry = await postCheckoutCustomer(tok, { line1: "1 Main St" });
  ok(
    "runtime: tax forces country on checkout despite a stored show",
    noCountry.statusCode === 400 && /Country is required/.test(noCountry.payload),
    show(noCountry),
  );
  // Control: the same stored config without tax lets it through.
  await setStored(plain.biz.id, { checkoutFieldConfig: { "billing.country": "show" } });
  const tok2 = await checkoutToken(plain.biz.id, plain.price.publicId);
  const ctl = await postCheckoutCustomer(tok2, { line1: "1 Main St" });
  ok(
    "control: without tax a stored show leaves country optional",
    ctl.statusCode === 200,
    show(ctl),
  );
  await setStored(plain.biz.id, { checkoutFieldConfig: null });
  await setStored(taxed.biz.id, { checkoutFieldConfig: null });
}

// ── F. GST locks state_code too ──────────────────────────────────────────────
const gst = await newBusiness("GST", "INR");
await configureIndiaGst({
  organizationId: orgId,
  businessId: gst.biz.id,
  homeStateCode: "TN",
  cgstBps: 900,
  sgstBps: 900,
});
{
  const g = json(await getBiz(gst.biz.publicId));
  ok(
    "GET business: GST region → both locks true",
    g.address_field_locks?.country === true && g.address_field_locks?.state_code === true,
    JSON.stringify(g.address_field_locks),
  );
  const p = await patchBiz(gst.biz.publicId, {
    portal_field_config: { "billing.state_code": "show" },
  });
  ok(
    "PATCH: portal state_code → show refused under GST",
    p.statusCode === 400 &&
      json(p).error?.message === "State must stay required while GST is set up.",
    show(p),
  );
  await setStored(gst.biz.id, {
    checkoutFieldConfig: { "billing.state_code": "hide" },
    portalFieldConfig: { "billing.state_code": "show" },
  });
  const tok = await checkoutToken(gst.biz.id, gst.price.publicId);
  const noState = await postCheckoutCustomer(tok, {
    line1: "1 MG Road",
    city: "Chennai",
    postal_code: "600001",
    country: "IN",
  });
  ok(
    "runtime: GST forces state on checkout despite a stored hide",
    noState.statusCode === 400,
    show(noState),
  );
  const g2 = json(await getBiz(gst.biz.publicId));
  ok(
    "GET business: portal_field_config shows the forced state_code",
    g2.portal_field_config?.["billing.state_code"] === "mandatory",
    JSON.stringify(g2.portal_field_config),
  );
}

// ── G. The 0334 data step ────────────────────────────────────────────────────
{
  const legacy = await newBusiness("Legacy");
  await setStored(legacy.biz.id, {
    checkoutFieldConfig: {
      "billing.city": "show",
      "billing.state_code": "hide",
      "billing.postal_code": "show",
      "billing.line1": "show",
      "customer.phone": "hide",
    },
  });
  const file = readFileSync(
    resolve(process.cwd(), "db/migrations/0334_address_field_rules.sql"),
    "utf8",
  );
  const update = file.split("--> statement-breakpoint")[1]!.trim().replace(/;\s*$/, "");
  await withTenant(orgId, (tx) => tx.execute(sql.raw(`${update} AND id = '${legacy.biz.id}'`)));
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({ cfg: businesses.checkoutFieldConfig })
      .from(businesses)
      .where(eq(businesses.id, legacy.biz.id)),
  );
  const cfg = row?.cfg as Record<string, string> | null;
  ok(
    "0334: stored show/hide on line1/city/state_code/postal_code → mandatory",
    cfg?.["billing.city"] === "mandatory" &&
      cfg?.["billing.state_code"] === "mandatory" &&
      cfg?.["billing.postal_code"] === "mandatory" &&
      cfg?.["billing.line1"] === "mandatory",
    JSON.stringify(cfg),
  );
  ok("0334: other keys untouched", cfg?.["customer.phone"] === "hide", JSON.stringify(cfg));
}

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
await closeDb();
process.exit(fail ? 1 : 0);
