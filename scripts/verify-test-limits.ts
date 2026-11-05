/**
 * verify:test-limits — a test business holds at most N customers and N subscriptions (0406).
 *
 * Pins:
 *  - the default: 1,000 on Cloud, none on self-hosted; an env number applies on every edition;
 *    0 = no limit; a business override wins,
 *  - the (N+1)th customer over the API is a 400 `test_business_limit_reached`, the Nth is not,
 *  - the (N+1)th subscription through the service is refused the same way,
 *  - a soft-deleted subscription frees its slot; an archived customer does not,
 *  - a live business with the same override is never limited,
 *  - concurrent creates at the last free slot: exactly one wins,
 *  - GET test_limits reports usage, and is a 400 on a live business.
 *
 *   pnpm verify:test-limits
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import {
  CLOUD_TEST_LIMIT,
  TestBusinessLimitError,
  defaultTestLimit,
} from "@/modules/tenancy/test-limits";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, deleteSubscription } from "@/modules/subscriptions/service";
import { businesses } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail !== undefined ? JSON.stringify(detail) : "");
}

const cfg = config as unknown as Record<string, unknown>;
const saved = {
  TMBILLING_EDITION: cfg.TMBILLING_EDITION,
  TEST_BUSINESS_CUSTOMER_LIMIT: cfg.TEST_BUSINESS_CUSTOMER_LIMIT,
  TEST_BUSINESS_SUBSCRIPTION_LIMIT: cfg.TEST_BUSINESS_SUBSCRIPTION_LIMIT,
};

// ── §A the default ─────────────────────────────────────────────────────────────────────────
cfg.TEST_BUSINESS_CUSTOMER_LIMIT = undefined;
cfg.TEST_BUSINESS_SUBSCRIPTION_LIMIT = undefined;
cfg.TMBILLING_EDITION = "self_hosted";
ok("self-hosted, unset: no limit", defaultTestLimit("customers") === null);
cfg.TMBILLING_EDITION = "cloud";
ok(
  `cloud, unset: ${CLOUD_TEST_LIMIT}`,
  defaultTestLimit("customers") === CLOUD_TEST_LIMIT &&
    defaultTestLimit("subscriptions") === CLOUD_TEST_LIMIT,
);
cfg.TEST_BUSINESS_CUSTOMER_LIMIT = 0;
ok("cloud, env 0: no limit", defaultTestLimit("customers") === null);
cfg.TMBILLING_EDITION = "self_hosted";
cfg.TEST_BUSINESS_CUSTOMER_LIMIT = 5;
ok("self-hosted, env 5: 5", defaultTestLimit("customers") === 5);
// The rest runs on self-hosted with no env limit, so only the overrides below apply.
cfg.TEST_BUSINESS_CUSTOMER_LIMIT = undefined;

// ── fixtures ───────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Test Limits Org" });
const orgId = org.organization.id;
const live = await createBusiness({
  organizationId: orgId,
  name: "Limits",
  defaultCurrency: "USD",
});
const [test] = await systemDb
  .select()
  .from(businesses)
  .where(eq(businesses.liveBusinessId, live.id))
  .limit(1);
const LIMIT = 3;
await systemDb
  .update(businesses)
  .set({ testCustomerLimit: LIMIT, testSubscriptionLimit: LIMIT })
  .where(eq(businesses.organizationId, orgId)); // live too: it must be ignored there
const key = org.secret; // the organization's own key reaches live and test

const app = await buildApp();
const post = (biz: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${biz}/customers`,
    headers: { authorization: `Bearer ${key}`, "idempotency-key": randomUUID() },
    payload: body,
  });
const getLimits = (biz: string) =>
  app.inject({
    method: "GET",
    url: `/v1/businesses/${biz}/test_limits`,
    headers: { authorization: `Bearer ${key}` },
  });

// ── §B customers over the API ──────────────────────────────────────────────────────────────
for (let i = 1; i <= LIMIT; i++) {
  const r = await post(test!.publicId, { email: `limit${i}@example.com` });
  ok(`test customer ${i} of ${LIMIT}: 201`, r.statusCode === 201, r.json());
}
const over = await post(test!.publicId, { email: "over@example.com" });
const err = over.json().error ?? {};
ok("customer past the limit: 400", over.statusCode === 400, over.json());
ok("  code test_business_limit_reached", err.code === "test_business_limit_reached", err);
ok(
  "  message names the limit",
  typeof err.message === "string" && err.message.includes(`limit of ${LIMIT} customers`),
  err.message,
);
for (let i = 1; i <= LIMIT + 1; i++) {
  const r = await post(live.publicId, { email: `live${i}@example.com` });
  if (i === LIMIT + 1) ok("live business ignores the override", r.statusCode === 201, r.json());
}

// ── §C subscriptions through the service ───────────────────────────────────────────────────
const ctx = { organizationId: orgId, businessId: test!.id };
await systemDb.update(businesses).set({ testCustomerLimit: 0 }).where(eq(businesses.id, test!.id)); // 0 = no limit, so customers stop being the bottleneck
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const subscribe = async () => {
  const c = await createCustomer({ ...ctx, email: `${randomUUID()}@example.com` });
  return createSubscription({
    ...ctx,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
};
ok("override 0 on customers: a 4th customer is created", !!(await createCustomer({ ...ctx })));
const subs = [];
for (let i = 0; i < LIMIT; i++) subs.push((await subscribe()).subscription);
const refused = await subscribe().then(
  () => null,
  (e: unknown) => e,
);
ok(
  "subscription past the limit: TestBusinessLimitError",
  refused instanceof TestBusinessLimitError && refused.kind === "subscriptions",
  String(refused),
);
await deleteSubscription({
  organizationId: orgId,
  businessId: test!.id,
  subscriptionId: subs[0]!.id,
  now: new Date(),
});
ok("a deleted subscription frees its slot", !!(await subscribe()).subscription);

// ── §D the last free slot under concurrency ────────────────────────────────────────────────
await systemDb.update(businesses).set({ testCustomerLimit: 20 }).where(eq(businesses.id, test!.id));
const now = (await getLimits(test!.publicId)).json();
const free = 20 - now.customers.used;
const racers = await Promise.allSettled(
  Array.from({ length: free + 4 }, () => createCustomer({ ...ctx })),
);
const won = racers.filter((r) => r.status === "fulfilled").length;
const lost = racers.filter(
  (r) => r.status === "rejected" && r.reason instanceof TestBusinessLimitError,
).length;
ok(`concurrent creates: ${free} win, 4 refused`, won === free && lost === 4, { won, lost, free });

// ── §E usage endpoint ──────────────────────────────────────────────────────────────────────
const usage = (await getLimits(test!.publicId)).json();
ok(
  "GET test_limits reports usage",
  usage.object === "test_limits" &&
    usage.customers.used === 20 &&
    usage.customers.limit === 20 &&
    usage.subscriptions.used === LIMIT &&
    usage.subscriptions.limit === LIMIT,
  usage,
);
const liveUsage = await getLimits(live.publicId);
ok("GET test_limits on a live business: 400", liveUsage.statusCode === 400, liveUsage.json());

await app.close();
Object.assign(cfg, saved);
await closeDb();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
