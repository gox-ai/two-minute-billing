/**
 * Catalog / coupon / entitlement / currency API surface, over HTTP:
 *  - opt-in paging on every catalog + coupon list (no paging param = the whole set, unchanged),
 *  - coupon retrieve, coupon-set PATCH/DELETE (archive), coupon-code retrieve + cross-set list,
 *  - differential price retrieve/delete, one-attachment retrieve/delete, plan → add-ons lookup,
 *  - per-customer redemption cap, price-scoped item constraints (money checked on an invoice),
 *  - feature retrieve/PATCH/archive/reactivate (archived = not granted),
 *  - currencies list/retrieve.
 *
 *   pnpm verify:catalog-api
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createCustomer } from "@/modules/customers/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { and } from "drizzle-orm";
import { prices as pricesTable, subscriptions } from "@db/schema";

const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fails.push(name);
};

const org = await createOrganization({ name: "Catalog API Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const app = await buildApp({ logger: false });
const AUTH = { authorization: `Bearer ${org.secret}` };
let n = 0;
const base = `/v1/businesses/${biz.publicId}`;
async function call(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url: `${base}${url}`,
    headers: { ...AUTH, "idempotency-key": `wp6-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  let body: any = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

// ── Catalog fixtures ──────────────────────────────────────────────────────────
for (const [id, kind] of [
  ["plan-a", "plan"],
  ["plan-b", "plan"],
  ["addon-x", "addon"],
  ["addon-y", "addon"],
  ["addon-z", "addon"],
] as const) {
  const r = await call("POST", "/products", { id, name: id, kind });
  if (r.status !== 201) console.log("product create", id, r.status, r.body);
}
const mkPrice = (product: string, id: string, amount: number) =>
  call("POST", "/prices", {
    product,
    id,
    model: "flat",
    currency: "USD",
    amount_minor: amount,
    interval: "month",
  });
await mkPrice("plan-a", "plan-a-usd", 10000);
await mkPrice("plan-b", "plan-b-usd", 20000);
await mkPrice("addon-x", "addon-x-usd", 1000);
await mkPrice("addon-x", "addon-x-usd-2", 3000);
await mkPrice("addon-y", "addon-y-usd", 2000);
await mkPrice("addon-z", "addon-z-usd", 500);
await mkPrice("addon-z", "addon-z-usd-2", 3000);

const priceRow = async (id: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(pricesTable)
          .where(and(eq(pricesTable.businessId, biz.id), eq(pricesTable.publicId, id)))
          .limit(1)
      )[0]!,
  );
async function newCustomer(email: string) {
  const customer = await createCustomer({ organizationId: orgId, businessId: biz.id, email });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  return customer;
}

// ── 1. Opt-in paging ─────────────────────────────────────────────────────────
const fullProducts = await call("GET", "/products");
check(
  "products: no paging param → whole set, legacy envelope (no has_more)",
  fullProducts.status === 200 &&
    fullProducts.body.data.length === 5 &&
    !("has_more" in fullProducts.body),
);
const legacyJunk = await call("GET", "/products?foo=bar");
check("products: unknown param without paging is still ignored (200)", legacyJunk.status === 200);
const p1 = await call("GET", "/products?limit=2");
const p2 = await call("GET", `/products?limit=2&starting_after=${p1.body.next_cursor}`);
const p3 = await call("GET", `/products?limit=2&starting_after=${p2.body.next_cursor}`);
const pagedIds = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((p: any) => p.id);
check(
  "products: 3 pages of 2 cover the set once, same order as unpaged",
  p1.body.has_more === true &&
    p1.body.total === 5 &&
    p3.body.has_more === false &&
    JSON.stringify(pagedIds) === JSON.stringify(fullProducts.body.data.map((p: any) => p.id)),
);
const addonsOnly = await call("GET", "/products?limit=50&kind[is]=addon&sort_by[asc]=id");
check(
  "products: kind[is] filter + sort_by in paged mode",
  addonsOnly.body.data.map((p: any) => p.id).join(",") === "addon-x,addon-y,addon-z",
);
const flatKind = await call("GET", "/products?limit=50&kind=plan");
check("products: flat kind param honoured when paged", flatKind.body.data.length === 2);
const badFilter = await call("GET", "/products?limit=5&colour[is]=red");
check("products: unknown filter field when paged → 400", badFilter.status === 400);
const search = await call("GET", "/products?limit=10&q=plan-");
check("products: q search when paged", search.body.data.length === 2);
const filteredUnpaged = await call("GET", "/products?kind[is]=addon&sort_by[desc]=id");
check(
  "products: filter + sort without paging → every match, legacy envelope",
  filteredUnpaged.status === 200 &&
    !("has_more" in filteredUnpaged.body) &&
    filteredUnpaged.body.data.map((p: any) => p.id).join(",") === "addon-z,addon-y,addon-x",
);
const searchUnpaged = await call("GET", "/products?q=addon-");
check("products: q without paging filters the whole set", searchUnpaged.body.data.length === 3);
const badUnpaged = await call("GET", "/products?colour[is]=red");
check("products: unknown filter field without paging → 400", badUnpaged.status === 400);

const pricesFull = await call("GET", "/prices");
const pricesPaged = await call(
  "GET",
  "/prices?limit=3&amount_minor[gte]=2000&sort_by[desc]=amount_minor",
);
check(
  "prices: whole set unpaged; amount filter + sort when paged",
  pricesFull.body.data.length === 7 &&
    !("has_more" in pricesFull.body) &&
    pricesPaged.body.data.map((p: any) => p.amount_minor).join(",") === "20000,10000,3000",
);
const pricesByProduct = await call("GET", "/prices?limit=10&product[is]=addon-x");
check("prices: product filter when paged", pricesByProduct.body.data.length === 2);

await call("POST", "/product_groups", { id: "grp-extra", name: "Extra" });
const groupsFull = await call("GET", "/product_groups");
const groupsPaged = await call("GET", "/product_groups?limit=1");
check(
  "product groups: whole set unpaged; paged envelope with total",
  groupsFull.body.data.length === 2 &&
    groupsPaged.body.data.length === 1 &&
    groupsPaged.body.total === 2 &&
    groupsPaged.body.has_more === true,
);

// ── 2. Attached items + differential prices + plan → add-ons ────────────────
await call("PUT", "/products/addon-x/applicable_plans", {
  plans: ["plan-a", "plan-b"],
  applicability: { "plan-a": "mandatory" },
});
const diff = await call("PUT", "/products/addon-y/differential_prices", {
  plan: "plan-a",
  currency: "USD",
  interval: "month",
  amount_minor: 1500,
});
await call("PATCH", "/products/addon-z", { addon_applies_to_all: true });

const one = await call("GET", "/products/addon-x/applicable_plans/plan-a");
check(
  "attached item: retrieve one (explicit, mandatory)",
  one.status === 200 && one.body.source === "attached" && one.body.applicability === "mandatory",
);
const addonsForA = await call("GET", "/prices/plan-a-usd/applicable_addons");
const bySrc = Object.fromEntries(addonsForA.body.data.map((a: any) => [a.item, a.source]));
check(
  "plan → add-ons: attached, differential-implied and applies-to-all",
  bySrc["addon-x"] === "attached" &&
    bySrc["addon-y"] === "differential" &&
    bySrc["addon-z"] === "all",
);
const notPlan = await call("GET", "/prices/addon-x-usd/applicable_addons");
check("plan → add-ons on an add-on price → 400", notPlan.status === 400);

const delOne = await call("DELETE", "/products/addon-x/applicable_plans/plan-b");
const afterDel = await call("GET", "/products/addon-x/applicable_plans");
check(
  "attached item: delete ONE keeps the rest of the set",
  delOne.status === 200 &&
    afterDel.body.plans.join(",") === "plan-a" &&
    afterDel.body.applicability["plan-a"] === "mandatory",
);
const delImplied = await call("DELETE", "/products/addon-y/applicable_plans/plan-a");
check("attached item: implied-only applicability → 404 on delete", delImplied.status === 404);

const dGet = await call("GET", `/differential_prices/${diff.body.id}`);
check(
  "differential price: retrieve by id",
  dGet.status === 200 && dGet.body.amount_minor === 1500 && dGet.body.plan === "plan-a",
);
const dDel = await call("DELETE", `/differential_prices/${diff.body.id}`);
const dGone = await call("GET", `/differential_prices/${diff.body.id}`);
const yAfter = await call("GET", "/products/addon-y/applicable_plans");
check(
  "differential price: delete removes it (and the applicability it implied)",
  dDel.status === 200 && dGone.status === 404 && yAfter.body.plans.length === 0,
);

// ── 3. Coupons ───────────────────────────────────────────────────────────────
await call("POST", "/coupons", {
  code: "ONCEPER",
  kind: "percentage",
  percent_off_bps: 1000,
  duration_type: "once",
  max_redemptions_per_customer: 1,
});
const cGet = await call("GET", "/coupons/ONCEPER");
check(
  "coupon: retrieve by code carries max_redemptions_per_customer",
  cGet.status === 200 && cGet.body.max_redemptions_per_customer === 1,
);
check("coupon: retrieve unknown → 404", (await call("GET", "/coupons/NOPE")).status === 404);

async function mkSub(email: string, price: string) {
  const customer = await newCustomer(email);
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: await priceRow(price), quantity: 1 }],
  });
  return { subscription, customer };
}
const s1 = await mkSub("cap1@example.com", "plan-a-usd");
const apply1 = await call("POST", `/subscriptions/${s1.subscription.publicId}/discount`, {
  code: "ONCEPER",
});
// Second subscription, same customer.
const priceB = await priceRow("plan-b-usd");
const s1b = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: s1.customer.id,
  now: new Date(),
  items: [{ price: priceB, quantity: 1 }],
});
const apply2 = await call("POST", `/subscriptions/${s1b.subscription.publicId}/discount`, {
  code: "ONCEPER",
});
const s2 = await mkSub("cap2@example.com", "plan-a-usd");
const apply3 = await call("POST", `/subscriptions/${s2.subscription.publicId}/discount`, {
  code: "ONCEPER",
});
check(
  "per-customer cap: 2nd redemption by the same customer → 400; another customer → 201",
  apply1.status === 201 &&
    apply2.status === 400 &&
    /per customer/.test(apply2.body?.error?.message ?? "") &&
    apply3.status === 201,
);
await call("POST", "/coupons", {
  code: "NOCAP",
  kind: "percentage",
  percent_off_bps: 500,
  duration_type: "once",
});
const noCap = await call("GET", "/coupons/NOCAP");
check(
  "coupon without the cap reads null (absent = unlimited)",
  noCap.body.max_redemptions_per_customer === null,
);

// Price-scoped constraint: 50% off addon-z-usd-2 only (not addon-z-usd, same product).
const scoped = await call("POST", "/coupons", {
  code: "PRICE50",
  kind: "percentage",
  percent_off_bps: 5000,
  duration_type: "forever",
  apply_on: "each_specified_item",
  item_constraints: [
    { item_kind: "addon", constraint_type: "specific", price_ids: ["addon-z-usd-2"] },
  ],
});
check(
  "price-scoped constraint stored + returned",
  scoped.status === 201 && scoped.body.item_constraints[0]?.price_ids?.[0] === "addon-z-usd-2",
);
const wrongKind = await call("POST", "/coupons", {
  code: "BADSCOPE",
  kind: "percentage",
  percent_off_bps: 5000,
  apply_on: "each_specified_item",
  item_constraints: [
    { item_kind: "plan", constraint_type: "specific", price_ids: ["addon-x-usd-2"] },
  ],
});
check("price_ids of another item kind → 400", wrongKind.status === 400);
async function billWith(priceIds: string[], code?: string) {
  const customer = await newCustomer(`scope${n}@example.com`);
  const rows = await Promise.all(priceIds.map(priceRow));
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: rows.map((price) => ({ price, quantity: 1 })),
  });
  if (code) await call("POST", `/subscriptions/${subscription.publicId}/discount`, { code });
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  return Number(invoice.totalMinor);
}
// plan-b 20000 + addon-z-usd-2 3000 → 50% off the add-on line only = 21500.
const t1 = await billWith(["plan-b-usd", "addon-z-usd-2"], "PRICE50");
// plan-b 20000 + addon-z-usd 500 (same product, other price) → untouched = 20500.
const t2 = await billWith(["plan-b-usd", "addon-z-usd"], "PRICE50");
console.log(`price scope: totals ${t1} / ${t2}`);
check("price-scoped coupon discounts only the named price (21500)", t1 === 21500);
check("price-scoped coupon leaves another price of the same product alone (20500)", t2 === 20500);

// Coupon list paging (portal route).
const cFull = await call("GET", "/coupons");
const cPaged = await call("GET", "/coupons?limit=1&sort_by[asc]=id");
const cStatus = await call("GET", "/coupons?limit=10&status[is]=active");
check(
  "coupons: whole set unpaged; paged + derived status filter",
  cFull.body.data.length === 3 &&
    !("has_more" in cFull.body) &&
    cPaged.body.data[0]?.id === "NOCAP" &&
    cPaged.body.total === 3 &&
    cStatus.body.data.length === 3,
);

// ── 4. Coupon sets + codes ───────────────────────────────────────────────────
const set = await call("POST", "/coupon_sets", {
  coupon: "NOCAP",
  name: "Spring",
  count: 3,
  id: "spring-set",
  metadata: { campaign: "spring" },
});
check(
  "coupon set: caller id + metadata",
  set.status === 201 && set.body.id === "spring-set" && set.body.metadata?.campaign === "spring",
);
const renamed = await call("PATCH", "/coupon_sets/spring-set", { name: "Spring 2026" });
check("coupon set: PATCH renames", renamed.status === 200 && renamed.body.name === "Spring 2026");
const codesLegacy = await call("GET", "/coupon_sets/spring-set/codes");
const codesPaged = await call("GET", "/coupon_sets/spring-set/codes?limit=2");
check(
  "set codes: whole set unpaged (legacy shape); paged with set/coupon",
  codesLegacy.body.data.length === 3 &&
    !("coupon_set" in codesLegacy.body.data[0]) &&
    codesPaged.body.data.length === 2 &&
    codesPaged.body.data[0].coupon_set === "spring-set",
);
const aCode = codesLegacy.body.data[0].code;
const codeGet = await call("GET", `/coupon_codes/${aCode}`);
check(
  "coupon code: retrieve",
  codeGet.status === 200 &&
    codeGet.body.coupon === "NOCAP" &&
    codeGet.body.status === "not_redeemed",
);
const cross = await call("GET", "/coupon_codes?coupon_set=spring-set");
const crossAll = await call("GET", "/coupon_codes?status[is]=not_redeemed");
check(
  "coupon codes: cross-set list + filters",
  cross.body.data.length === 3 && crossAll.body.data.length === 3,
);
const archived = await call("DELETE", "/coupon_sets/spring-set");
const setAfter = await call("GET", "/coupon_sets/spring-set");
const s3 = await mkSub("setcode@example.com", "plan-a-usd");
const redeemArchived = await call("POST", `/subscriptions/${s3.subscription.publicId}/discount`, {
  code: aCode,
});
const addToArchived = await call("POST", "/coupon_sets/spring-set/codes", { count: 1 });
check(
  "coupon set: DELETE archives — codes archived, redeem refused, adding refused",
  archived.status === 200 &&
    archived.body.archived_at != null &&
    setAfter.body.unredeemed_count === 0 &&
    setAfter.body.archived_count === 3 &&
    redeemArchived.status === 400 &&
    addToArchived.status === 400,
);
const setsDefault = await call("GET", "/coupon_sets");
const setsWithArchived = await call("GET", "/coupon_sets?include_archived=true");
const setsFilteredDefault = await call("GET", "/coupon_sets?archived_at[is_present]=true");
check(
  "coupon sets: archived hidden by default, shown with include_archived=true",
  setsDefault.body.data.length === 0 &&
    setsWithArchived.body.data.length === 1 &&
    setsFilteredDefault.body.data.length === 0,
);
const setsPaged = await call(
  "GET",
  "/coupon_sets?limit=5&include_archived=true&archived_at[is_present]=true",
);
check(
  "coupon sets: paged + archived_at filter",
  setsPaged.body.data.length === 1 && setsPaged.body.total === 1,
);
const codesFiltered = await call("GET", "/coupon_sets/spring-set/codes?status[is]=archived");
check(
  "set codes: filter without paging → every match, legacy envelope",
  codesFiltered.body.data.length === 3 && !("has_more" in codesFiltered.body),
);

// ── 5. Features ──────────────────────────────────────────────────────────────
const feat = await call("POST", "/features", { key: "sso", name: "SSO", type: "switch" });
await call("POST", "/products/plan-a/entitlements", { feature: "sso", value: "true" });
const byKey = await call("GET", "/features/sso");
const byId = await call("GET", `/features/${feat.body.id}`);
check("feature: retrieve by key and by id", byKey.status === 200 && byId.body.key === "sso");
const patched = await call("PATCH", "/features/sso", { name: "Single sign-on", unit: null });
const immut = await call("PATCH", "/features/sso", { type: "quota" });
check(
  "feature: PATCH name; key/type immutable (400)",
  patched.body.name === "Single sign-on" && immut.status === 400,
);
const chk = () => call("GET", `/subscriptions/${s1.subscription.publicId}/entitlements/sso/check`);
const before = await chk();
const arch = await call("POST", "/features/sso/archive");
const during = await chk();
const effDuring = await call("GET", `/subscriptions/${s1.subscription.publicId}/entitlements`);
const grantArchived = await call("POST", "/products/plan-b/entitlements", {
  feature: "sso",
  value: "true",
});
const react = await call("POST", "/features/sso/reactivate");
const after = await chk();
check(
  "feature: archive → not granted (feature_archived), reactivate → granted again",
  before.body.entitled === true &&
    arch.body.active === false &&
    during.body.entitled === false &&
    during.body.reason === "feature_archived" &&
    effDuring.body.data.length === 0 &&
    grantArchived.status === 400 &&
    react.body.active === true &&
    after.body.entitled === true,
);
const delFeat = await call("DELETE", "/features/sso");
check("feature: DELETE archives", delFeat.status === 200 && delFeat.body.active === false);

// ── 6. Currencies ────────────────────────────────────────────────────────────
await call("PUT", "/currencies/EUR", { source: "manual", rate: "0.9" });
const curs = await call("GET", "/currencies");
const eur = await call("GET", "/currencies/eur");
check(
  "currencies: base first, then rated; retrieve is case-insensitive",
  curs.body.data[0]?.currency === "USD" &&
    curs.body.data[0]?.is_base === true &&
    eur.status === 200 &&
    eur.body.rate === "0.9" &&
    eur.body.source === "manual",
);
check("currencies: unknown → 404", (await call("GET", "/currencies/JPY")).status === 404);

// ── RLS: another org sees none of it ─────────────────────────────────────────
const org2 = await createOrganization({ name: "Other Org" });
const foreign = await app.inject({
  method: "GET",
  url: `${base}/coupons/ONCEPER`,
  headers: { authorization: `Bearer ${org2.secret}` },
});
check("RLS: another org cannot read the coupon", foreign.statusCode === 404);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ CATALOG API: PASS" : `❌ CATALOG API: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
