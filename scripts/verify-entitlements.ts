/**
 * Entitlements / feature-gating: create features,
 * attach to plans with granted values, resolve effective entitlements for a
 * subscription (plan ∪ per-subscription overrides, multi-plan merge), and the
 * check API (switch on/off, quota within/over, unlimited, not-granted), and the
 * change events a cache depends on (feature_*, plan_entitlement_set,
 * subscription_entitlement_set).
 *
 *   pnpm verify:entitlements
 */
import { and, asc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { events } from "@db/schema";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import {
  createFeature,
  setPlanEntitlement,
  setSubscriptionEntitlement,
  effectiveEntitlements,
  checkEntitlement,
  updateFeature,
  setFeatureActive,
} from "@/modules/entitlements/service";

const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fails.push(name);
};

const org = await createOrganization({ name: "Ent Org" });
const orgId = org.organization.id;
const biz = await createBusiness({ organizationId: orgId, name: "Biz", defaultCurrency: "USD" });
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "e@a.com",
});

// Two plans: Pro and an Analytics add-on.
const pro = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const addon = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Analytics Addon",
});
const proPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: pro.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
  interval: "month",
});
const addonPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: addon.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

// Features: switch (sso), quota (max_projects), meter (api_calls).
const sso = await createFeature({
  organizationId: orgId,
  businessId: biz.id,
  key: "sso",
  name: "SSO",
  type: "switch",
});
const projects = await createFeature({
  organizationId: orgId,
  businessId: biz.id,
  key: "max_projects",
  name: "Max projects",
  type: "quota",
  unit: "projects",
});
const apiCalls = await createFeature({
  organizationId: orgId,
  businessId: biz.id,
  key: "api_calls",
  name: "API calls",
  type: "meter",
  unit: "calls",
});
const reports = await createFeature({
  organizationId: orgId,
  businessId: biz.id,
  key: "reports",
  name: "Reports",
  type: "switch",
});

// Pro grants: sso on, 10 projects, 100000 api calls. Addon grants: 5 more projects (merge→max), reports on.
await setPlanEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  productId: pro.id,
  featureId: sso.id,
  value: "true",
});
await setPlanEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  productId: pro.id,
  featureId: projects.id,
  value: "10",
});
await setPlanEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  productId: pro.id,
  featureId: apiCalls.id,
  value: "100000",
});
await setPlanEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  productId: addon.id,
  featureId: projects.id,
  value: "5",
});
await setPlanEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  productId: addon.id,
  featureId: reports.id,
  value: "true",
});

// Subscription on BOTH plans.
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [
    { price: proPrice, quantity: 1 },
    { price: addonPrice, quantity: 1 },
  ],
});

// --- Effective entitlements (plan resolution + multi-plan merge) ---
let ents = await effectiveEntitlements(orgId, sub.subscription.id);
const byKey = Object.fromEntries(ents.map((e) => [e.feature_key, e]));
console.log("effective:", ents.map((e) => `${e.feature_key}=${e.value}(${e.source})`).join(" "));
check("sso resolved true", byKey["sso"]?.value === "true");
check("max_projects merged to max(10,5)=10", byKey["max_projects"]?.value === "10");
check("api_calls = 100000", byKey["api_calls"]?.value === "100000");
check("reports from addon = true", byKey["reports"]?.value === "true");
check(
  "all from plan source",
  ents.every((e) => e.source === "plan"),
);

// --- check API: switch ---
check(
  "check sso → entitled",
  (await checkEntitlement(orgId, sub.subscription.id, "sso")).entitled === true,
);
check(
  "check reports → entitled",
  (await checkEntitlement(orgId, sub.subscription.id, "reports")).entitled === true,
);
// not granted feature
const missing = await checkEntitlement(orgId, sub.subscription.id, "nonexistent_feature");
check(
  "check unknown feature → not entitled (not_granted)",
  missing.entitled === false && missing.reason === "not_granted",
);

// --- check API: quota within / over ---
check(
  "max_projects need 10 → within",
  (await checkEntitlement(orgId, sub.subscription.id, "max_projects", 10)).entitled === true,
);
check(
  "max_projects need 11 → over",
  (await checkEntitlement(orgId, sub.subscription.id, "max_projects", 11)).entitled === false,
);
check(
  "max_projects default (1) → within",
  (await checkEntitlement(orgId, sub.subscription.id, "max_projects")).entitled === true,
);

// --- Per-subscription override (custom deal): bump projects to unlimited ---
await setSubscriptionEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: sub.subscription.id,
  featureId: projects.id,
  value: "unlimited",
});
ents = await effectiveEntitlements(orgId, sub.subscription.id);
const proj2 = ents.find((e) => e.feature_key === "max_projects")!;
check(
  "override sets max_projects = unlimited (source=override)",
  proj2.value === "unlimited" && proj2.source === "override",
);
check(
  "unlimited → any required within",
  (await checkEntitlement(orgId, sub.subscription.id, "max_projects", 999999)).entitled === true,
);

// --- Override can also turn a switch OFF for one sub ---
await setSubscriptionEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: sub.subscription.id,
  featureId: sso.id,
  value: "false",
});
check(
  "override sso → off",
  (await checkEntitlement(orgId, sub.subscription.id, "sso")).entitled === false,
);

// --- Upsert: re-attaching a plan entitlement updates the value (no dup) ---
await setPlanEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  productId: pro.id,
  featureId: apiCalls.id,
  value: "250000",
});
const ents3 = await effectiveEntitlements(orgId, sub.subscription.id);
check(
  "plan entitlement upsert updates value to 250000",
  ents3.find((e) => e.feature_key === "api_calls")?.value === "250000",
);

// --- Change events (outbox, same transaction as the write) ---
type Ev = { publicId: string; data: Record<string, Record<string, unknown>> };
const eventsOf = (type: string): Promise<Ev[]> =>
  withTenant(orgId, (tx) =>
    tx
      .select({ publicId: events.publicId, data: events.data })
      .from(events)
      .where(and(eq(events.organizationId, orgId), eq(events.type, type)))
      .orderBy(asc(events.createdAt), asc(events.id)),
  ) as Promise<Ev[]>;
const last = (xs: Ev[]) => xs[xs.length - 1]?.data;

const created = await eventsOf("feature_created");
check(
  "feature_created per feature, with key and type",
  created.length === 4 &&
    created.some((e) => e.data.feature?.key === "max_projects" && e.data.feature?.type === "quota"),
);
const planSets = await eventsOf("plan_entitlement_set");
// 5 first grants + the api_calls upsert to 250000.
check("plan_entitlement_set per changed grant", planSets.length === 6);
const upsert = last(planSets)?.plan_entitlement;
check(
  "plan_entitlement_set carries product, feature, value and previous_value",
  upsert?.product === pro.publicId &&
    upsert?.feature === "api_calls" &&
    upsert?.value === "250000" &&
    upsert?.previous_value === "100000",
);
check(
  "a first grant has previous_value null",
  planSets[0]?.data.plan_entitlement?.previous_value === null,
);
await setPlanEntitlement({
  organizationId: orgId,
  businessId: biz.id,
  productId: pro.id,
  featureId: apiCalls.id,
  value: "250000",
});
check(
  "re-setting the same value emits nothing",
  (await eventsOf("plan_entitlement_set")).length === 6,
);
const subSets = await eventsOf("subscription_entitlement_set");
check(
  "subscription_entitlement_set per override, naming the subscription",
  subSets.length === 2 &&
    last(subSets)?.subscription_entitlement?.subscription === sub.subscription.publicId &&
    last(subSets)?.subscription_entitlement?.feature === "sso" &&
    last(subSets)?.subscription_entitlement?.value === "false" &&
    last(subSets)?.subscription_entitlement?.previous_value === null,
);

const seats = await createFeature({
  organizationId: orgId,
  businessId: biz.id,
  key: "seats",
  name: "Seats",
  type: "quota",
});
await updateFeature({
  organizationId: orgId,
  businessId: biz.id,
  featureId: seats.id,
  name: "Team seats",
});
await updateFeature({ organizationId: orgId, businessId: biz.id, featureId: seats.id });
const updated = await eventsOf("feature_updated");
check(
  "feature_updated on an edit, none for an empty edit",
  updated.length === 1 && last(updated)?.feature?.name === "Team seats",
);
await setFeatureActive(orgId, biz.id, seats.id, false);
await setFeatureActive(orgId, biz.id, seats.id, false);
check(
  "feature_archived once, not again for an archived feature",
  (await eventsOf("feature_archived")).length === 1 &&
    last(await eventsOf("feature_archived"))?.feature?.active === false,
);
await setFeatureActive(orgId, biz.id, seats.id, true);
const reactivated = await eventsOf("feature_updated");
check(
  "reactivating sends feature_updated with active true",
  reactivated.length === 2 && last(reactivated)?.feature?.active === true,
);

// --- HTTP: the check endpoint over the wire ---
const app = await buildApp({ logger: false });
const AUTH = { authorization: `Bearer ${org.secret}` };

// DELETE archives, so its event is feature_archived (with the API's public id).
const del = await app.inject({
  method: "DELETE",
  url: `/v1/businesses/${biz.publicId}/features/seats`,
  headers: { ...AUTH, "idempotency-key": `ent-del-${Date.now()}` },
});
const archived = await eventsOf("feature_archived");
check(
  "HTTP DELETE feature → 200 and feature_archived",
  del.statusCode === 200 && archived.length === 2 && last(archived)?.feature?.id === seats.publicId,
);
const res = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/subscriptions/${sub.subscription.publicId}/entitlements/api_calls/check?required=200000`,
  headers: AUTH,
});
const body = JSON.parse(res.body);
console.log("HTTP check:", res.statusCode, body.entitled, body.value);
check(
  "HTTP check api_calls need 200000 → within (250000)",
  res.statusCode === 200 && body.entitled === true && body.value === "250000",
);

const listRes = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/subscriptions/${sub.subscription.publicId}/entitlements`,
  headers: AUTH,
});
check(
  "HTTP list entitlements returns 200 list",
  listRes.statusCode === 200 && JSON.parse(listRes.body).object === "list",
);

// --- HTTP: a product's plan entitlements ---
const prodEnts = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/products/${pro.publicId}/entitlements`,
  headers: AUTH,
});
const prodBody = JSON.parse(prodEnts.body);
const prodByKey = Object.fromEntries(
  (prodBody.data ?? []).map((e: { feature: string }) => [e.feature, e]),
);
check(
  "HTTP product entitlements: 200 list of the plan's own 3 grants",
  prodEnts.statusCode === 200 && prodBody.object === "list" && prodBody.data?.length === 3,
);
check(
  "HTTP product entitlements: upserted value + feature detail",
  prodByKey["api_calls"]?.value === "250000" &&
    prodByKey["api_calls"]?.object === "plan_entitlement" &&
    prodByKey["api_calls"]?.feature_name === "API calls" &&
    prodByKey["api_calls"]?.type === "meter" &&
    prodByKey["api_calls"]?.unit === "calls",
);
check(
  "HTTP product entitlements: overrides and other plans excluded",
  prodByKey["max_projects"]?.value === "10" &&
    prodByKey["sso"]?.value === "true" &&
    !prodByKey["reports"],
);
const addonEnts = JSON.parse(
  (
    await app.inject({
      method: "GET",
      url: `/v1/businesses/${biz.publicId}/products/${addon.publicId}/entitlements`,
      headers: AUTH,
    })
  ).body,
);
check("HTTP product entitlements: addon lists its 2 grants", addonEnts.data?.length === 2);
const biz2 = await createBusiness({
  organizationId: orgId,
  name: "Biz Two",
  defaultCurrency: "USD",
});
const crossBiz = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz2.publicId}/products/${pro.publicId}/entitlements`,
  headers: AUTH,
});
check("HTTP product entitlements: another business's product → 404", crossBiz.statusCode === 404);

// --- RLS isolation: a second org cannot see / resolve org1's subscription ---
const org2 = await createOrganization({ name: "Other Org" });
const ents4 = await effectiveEntitlements(org2.organization.id, sub.subscription.id);
check("RLS: other org resolves 0 entitlements for org1 sub", ents4.length === 0);
const crossOrg = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/products/${pro.publicId}/entitlements`,
  headers: { authorization: `Bearer ${org2.secret}` },
});
check("HTTP product entitlements: another org → 404", crossOrg.statusCode === 404);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ ENTITLEMENTS: PASS" : `❌ ENTITLEMENTS: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
