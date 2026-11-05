/**
 * Changed events — every real edit to a customer or a subscription emits exactly one
 * `customer_updated` / `subscription_changed`, a no-op edit emits none, and the event reaches
 * a subscribed webhook endpoint carrying the updated object (metadata included).
 *
 *   pnpm verify:change-events
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createApiKey } from "@/modules/tenancy/service";
import { createEndpoint } from "@/modules/webhooks/endpoints";
import { emailTypeForEvent } from "@/modules/emails/outbox";
import { Tmbilling } from "../sdk/index";
import { businesses, events, webhookDeliveries } from "@db/schema";
import { pinMfaMandateOff } from "./lib/mfa-policy";

pinMfaMandateOff();

const checks: Array<[string, boolean, string?]> = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const org = await createOrganization({ name: "Change Events Co" });
const orgId = org.organization.id;
const key = await createApiKey(orgId, "test");
const tmb = new Tmbilling({ apiKey: key.secret, baseUrl: base });
const auth = { Authorization: `Bearer ${key.secret}`, "Content-Type": "application/json" };

const biz = await tmb.businesses.create({
  name: "Change Biz",
  default_currency: "USD",
  livemode: "test",
});
const [bizRow] = await systemDb
  .select()
  .from(businesses)
  .where(eq(businesses.publicId, biz.id))
  .limit(1);
const product = await tmb.products.create(biz.id, { name: "Plan" });
const price = await tmb.prices.create(biz.id, {
  product: product.id,
  model: "per_unit",
  currency: "USD",
  amount_minor: 5000,
  interval: "month",
});
const customer = await tmb.customers.create(biz.id, {
  email: "chg@example.com",
  first_name: "Chg",
});
await tmb.paymentMethods.create(biz.id, customer.id, { token: "tok_4242" });
const sub = await tmb.subscriptions.create(biz.id, customer.id, { items: [{ price: price.id }] });

const endpoint = await createEndpoint({
  organizationId: orgId,
  businessId: bizRow!.id,
  livemode: "test",
  url: "https://example.com/hooks/change-events",
  eventTypes: ["customer_updated", "subscription_changed"],
});
const endpointId = endpoint.endpoint.id;

/** Events of `type` on `resourceId` written after `since`, with their delivery count. */
async function emitted(type: string, resourceId: string, since: Date) {
  const rows = await systemDb
    .select()
    .from(events)
    .where(
      and(
        eq(events.organizationId, orgId),
        eq(events.type, type),
        eq(events.resourceId, resourceId),
        gt(events.createdAt, since),
      ),
    );
  const deliveries = rows.length
    ? await systemDb
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            inArray(
              webhookDeliveries.eventId,
              rows.map((r) => r.id),
            ),
            eq(webhookDeliveries.endpointId, endpointId),
          ),
        )
    : [];
  const last = rows.at(-1);
  return {
    count: rows.length,
    data: last?.data as Record<string, any> | undefined,
    email: last ? emailTypeForEvent(last) : undefined,
    deliveries: deliveries.length,
  };
}

async function call(method: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...auth, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Database timestamps are the clock here; a small pause keeps `since` strictly before the write.
const mark = async () => {
  await new Promise((r) => setTimeout(r, 15));
  const rows = (await systemDb.execute(`select now() as now`)) as unknown as Array<{ now: Date }>;
  return new Date(rows[0]!.now);
};

const cusPath = `/v1/businesses/${biz.id}/customers/${customer.id}`;
const subPath = `/v1/businesses/${biz.id}/subscriptions/${sub.id}`;

// ── customers ──────────────────────────────────────────────────────────────────
{
  let t = await mark();
  let r = await call("PATCH", cusPath, { metadata: { tier: "gold" } });
  let e = await emitted("customer_updated", customer.id, t);
  ok("customer metadata change → 200", r.status === 200, r.text.slice(0, 200));
  ok(
    "customer metadata change emits exactly one customer_updated",
    e.count === 1,
    `count=${e.count}`,
  );
  ok(
    "customer_updated carries the new metadata",
    e.data?.customer?.metadata?.tier === "gold",
    JSON.stringify(e.data?.customer?.metadata),
  );
  ok(
    "customer_updated is queued for the subscribed endpoint",
    e.deliveries === 1,
    `deliveries=${e.deliveries}`,
  );

  t = await mark();
  r = await call("PATCH", cusPath, { metadata: { tier: "gold" } });
  e = await emitted("customer_updated", customer.id, t);
  ok("a no-op customer PATCH (same metadata) → 200", r.status === 200, r.text.slice(0, 200));
  ok("a no-op customer PATCH emits no customer_updated", e.count === 0, `count=${e.count}`);

  t = await mark();
  r = await call("PATCH", cusPath, { first_name: "Changed", metadata: { tier: "silver" } });
  e = await emitted("customer_updated", customer.id, t);
  ok(
    "a two-field customer change emits exactly one customer_updated",
    e.count === 1,
    `count=${e.count}`,
  );
}

// ── subscriptions ──────────────────────────────────────────────────────────────
{
  let t = await mark();
  let r = await call("PATCH", subPath, { metadata: { core_destination: "gs" } });
  let e = await emitted("subscription_changed", sub.id, t);
  ok("subscription metadata change → 200", r.status === 200, r.text.slice(0, 200));
  ok(
    "subscription metadata change emits exactly one subscription_changed",
    e.count === 1,
    `count=${e.count}`,
  );
  ok(
    "subscription_changed carries the new metadata",
    e.data?.subscription?.metadata?.core_destination === "gs",
    JSON.stringify(e.data?.subscription?.metadata),
  );
  ok(
    "subscription_changed is queued for the subscribed endpoint",
    e.deliveries === 1,
    `deliveries=${e.deliveries}`,
  );
  ok("a metadata-only change does not email the customer", e.email === null, `email=${e.email}`);

  t = await mark();
  r = await call("PATCH", subPath, { metadata: { core_destination: "gs" } });
  e = await emitted("subscription_changed", sub.id, t);
  ok("a no-op subscription PATCH (same metadata) → 200", r.status === 200, r.text.slice(0, 200));
  ok("a no-op subscription PATCH emits no subscription_changed", e.count === 0, `count=${e.count}`);

  t = await mark();
  r = await call("PATCH", subPath, { po_number: "PO-77", auto_collection: "off" });
  e = await emitted("subscription_changed", sub.id, t);
  ok(
    "a settings change (PO + auto-collection) emits exactly one subscription_changed",
    e.count === 1,
    `count=${e.count} ${r.text.slice(0, 120)}`,
  );

  // `/change` needs an item operation; metadata rides along with it (a metadata-only edit is
  // the PATCH above). Items and metadata together must still be ONE event.
  const itemId = (sub as unknown as { items: Array<{ id: string }> }).items[0]!.id;
  t = await mark();
  r = await call("POST", `${subPath}/change`, {
    changes: [{ item: itemId, quantity: 2 }],
    prorate: false,
    invoice_immediately: false,
    metadata: { core_destination: "gds" },
  });
  e = await emitted("subscription_changed", sub.id, t);
  ok("/change with items + metadata → 200", r.status === 200, r.text.slice(0, 200));
  ok(
    "/change with items + metadata emits exactly one subscription_changed",
    e.count === 1,
    `count=${e.count}`,
  );
  ok(
    "an item change still emails the customer",
    e.email === "subscription_changed",
    `email=${e.email}`,
  );
  ok(
    "/change's subscription_changed carries the new metadata",
    e.data?.subscription?.metadata?.core_destination === "gds",
    JSON.stringify(e.data?.subscription?.metadata),
  );

  // update_for_items: items and metadata in one call announce ONE event that carries the
  // metadata; metadata alone still announces; a full no-op announces nothing.
  const ufi = `${subPath}/update_for_items`;
  t = await mark();
  r = await call("POST", ufi, {
    items: [{ price: price.id, quantity: 3 }],
    prorate: false,
    invoice_immediately: false,
    metadata: { core_destination: "gs" },
  });
  e = await emitted("subscription_changed", sub.id, t);
  ok("update_for_items with items + metadata → 200", r.status === 200, r.text.slice(0, 200));
  ok(
    "update_for_items with items + metadata emits exactly one subscription_changed",
    e.count === 1,
    `count=${e.count}`,
  );
  ok(
    "update_for_items' subscription_changed carries the new metadata",
    e.data?.subscription?.metadata?.core_destination === "gs",
    JSON.stringify(e.data?.subscription?.metadata),
  );

  t = await mark();
  r = await call("POST", ufi, {
    items: [{ price: price.id, quantity: 3 }],
    metadata: { core_destination: "gds" },
  });
  e = await emitted("subscription_changed", sub.id, t);
  ok(
    "update_for_items with metadata only emits exactly one subscription_changed",
    e.count === 1,
    `count=${e.count} ${r.text.slice(0, 120)}`,
  );
  ok(
    "update_for_items with metadata only does not email the customer",
    e.email === null,
    `email=${e.email}`,
  );

  t = await mark();
  r = await call("POST", ufi, {
    items: [{ price: price.id, quantity: 3 }],
    metadata: { core_destination: "gds" },
  });
  e = await emitted("subscription_changed", sub.id, t);
  ok("a no-op update_for_items emits no subscription_changed", e.count === 0, `count=${e.count}`);
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (pass) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
await app.close();
await closeDb();
console.log(
  failed
    ? `\n❌ CHANGE-EVENTS: FAIL (${failed}/${checks.length})`
    : `\n✅ CHANGE-EVENTS: PASS (${checks.length} checks)`,
);
process.exit(failed ? 1 : 0);
