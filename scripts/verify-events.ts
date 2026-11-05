/**
 * Phase A — Events core verify suite.
 *
 * Grows across EV-1..EV-4:
 *  - EV-1: registry sanity + exhaustiveness (no `emitEvent` uses a non-registry string),
 *          and every payment event payload names its invoice or its customer.
 *  - EV-2: envelope enrichment (source/actor/resource + resource_version in the body).
 *  - EV-3: a scripted lifecycle emits the exact expected event sequence.
 *  - EV-4: /v1/events filter + cursor-pagination round-trips.
 *
 *   pnpm verify:events
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization, createBusiness, createApiKey } from "@/modules/tenancy/service";
import { signup } from "@/modules/auth/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { runWithEventContext } from "@/platform/event-context";
import {
  getSubscriptionItems,
  createSubscription,
  cancelSubscription,
} from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { runDunningPass } from "@/modules/subscriptions/dunning";
import { issueAdjustmentCreditNote } from "@/modules/credit-notes/service";
import { withTenant } from "@/platform/db";
import { listEventsFiltered } from "@/modules/events/service";
import { EVENT_TYPES, isEventType, resourceTypeOf } from "@/modules/events/registry";
import { Tmbilling } from "../sdk/index";
import { subscriptions, prices, invoices, events, webhookDeliveries } from "@db/schema";
import { pinMfaMandateOff } from "./lib/mfa-policy";

// Not a test of the MFA mandate — see scripts/lib/mfa-policy.ts. Must precede any fixture.
pinMfaMandateOff();

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

// ── EV-1: registry sanity ────────────────────────────────────────────────────
// ADR-009 Part B: event types are snake_case (e.g. `customer_created`), not dot-case.
const slugRe = /^[a-z]+(?:_[a-z]+)+$/;
ok("registry has no duplicate event types", new Set(EVENT_TYPES).size === EVENT_TYPES.length);
ok(
  "every registry type is well-formed snake_case",
  EVENT_TYPES.every((t) => slugRe.test(t)),
);

// ── EV-1: exhaustiveness — no emitEvent() call uses a string outside the registry ──
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const offenders: string[] = [];
for (const file of walk("src")) {
  const src = readFileSync(file, "utf8");
  // Split on emitEvent( call boundaries; the `type:` expression always precedes `data:`.
  const parts = src.split(/emitEvent\s*\(/).slice(1);
  for (const part of parts) {
    const head = part.slice(0, part.indexOf("data:") >= 0 ? part.indexOf("data:") : 400);
    if (!head.includes("type:")) continue;
    const typeExpr = head.slice(head.indexOf("type:"));
    for (const m of typeExpr.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) {
      const literal = m[1]!;
      if (!isEventType(literal)) offenders.push(`${file}: '${literal}'`);
    }
  }
}
ok("no emitEvent() call uses a non-registry event string", offenders.length === 0);
if (offenders.length) for (const o of offenders) console.log("    ✗ offender:", o);

// ── EV-1: every payment event names what the money was FOR ───────────────────
// `events/content.ts` enriches a payment event from `data.payment.invoice`, falling back
// to `data.payment.customer`. It has no third route: the event's resource id is a `pay_…`
// and `loadTransactionSnapshot` matches `transactions.public_id`, so that lookup always
// misses. A payload naming neither ships as a bare amount with nobody to attribute it to,
// and a consumer can only drop it — four settled renewals went unrecorded downstream that
// way between 2026-09-09 and 2026-09-13, each answered 200 and never redelivered.
//
// Static because the failure is a MISSING KEY at one emit site among nine. Every suite
// that exercises these paths asserts on money and passed throughout; a new emit site
// added without a ref would be silent again. Spread syntax is deliberately NOT accepted —
// a ref hidden behind `...refs` is invisible here and to the next reader.
const refless: string[] = [];
for (const file of walk("src")) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(
    /buildEventData\(\s*\n?\s*"(payment_succeeded|payment_failed)"\s*,/g,
  )) {
    const from = m.index! + m[0].length;
    const open = src.indexOf("{", from);
    if (open < 0) continue;
    let depth = 0,
      end = open;
    for (; end < src.length; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}" && --depth === 0) break;
    }
    const payload = src.slice(open, end);
    // Exempt: a payload whose `id` is a TRANSACTION public id needs no ref. `deriveResourceId`
    // lifts `data.payment.id` into `resource.id`, so `loadTransactionSnapshot` hits and
    // enrichment runs through transaction → invoice → customer (the late-failure path in
    // `webhooks/inbound.ts`). Only a `pay_…` id leaves that lookup with nothing to find.
    if (/\bid:\s*txn\.publicId\b/.test(payload)) continue;
    if (!/\binvoice\s*:/.test(payload) && !/\bcustomer\s*:/.test(payload))
      refless.push(`${file}: ${m[1]} payload names neither invoice nor customer`);
  }
}
ok("every payment_succeeded/_failed payload names an invoice or a customer", refless.length === 0);
if (refless.length) for (const r of refless) console.log("    ✗ offender:", r);

// ── EV-1: every event's data names its own resource ──────────────────────────
// `deriveResourceId` reads `data[resourceTypeOf(type)]` and accepts a bare public-id
// STRING or an object with `id`. Find nothing and `buildEventContent` returns BEFORE its
// switch — so the event ships with no customer, no invoice, no subscription, whatever its
// type and however complete the enrichment case for it is. Silent in every direction.
//
// `buildEventData` nests under the right key by construction, so only RAW `data:` literals
// can get this wrong. The call object is brace-matched rather than window-sliced: a
// `type:` that is a ternary sits next to a `data:` that is one too, and a fixed-width
// window pairs one site's type with the next site's data (it flagged `webhooks/inbound.ts`,
// which is correct, on exactly that mistake).
function objectAt(src: string, from: number): { body: string; end: number } | null {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { body: src.slice(open, i + 1), end: i };
  }
  return null;
}

const unplaceable: string[] = [];
for (const file of walk("src")) {
  if (file.endsWith("modules/events/emit.ts")) continue; // the definition, not a call
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bemitEvent\(/g)) {
    const call = objectAt(src, m.index! + m[0].length);
    if (!call) continue;
    const tm = call.body.match(/\btype:\s*"([a-z_]+)"/);
    const dm = call.body.match(/\bdata:\s*/);
    if (!tm || !dm) continue; // a computed type always pairs with a computed payload here
    const data = call.body.slice(dm.index! + dm[0].length);
    if (/^buildEventData\b/.test(data.trimStart())) continue;
    const payload = objectAt(data, 0);
    if (!payload) continue;
    const rt = resourceTypeOf(tm[1]! as never);
    if (!new RegExp(`\\b${rt}:`).test(payload.body))
      unplaceable.push(
        `${file}:${src.slice(0, m.index!).split("\n").length}  ${tm[1]} — data names no "${rt}"`,
      );
  }
}
ok("every raw event payload names its own resource type", unplaceable.length === 0);
if (unplaceable.length) for (const u of unplaceable) console.log("    ✗ offender:", u);

// ── EV-2/3/4: scripted lifecycle → event sequence, enrichment, API round-trips ─
const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const org = await createOrganization({ name: "Events Co" });
const orgId = org.organization.id;
// The org's bootstrap credential is `kind='dashboard'` (what our own UI runs on), so
// requests made with it record `source='dashboard'`. This suite is about INTEGRATION
// provenance, so it mints a plain API key and drives everything with that; the
// dashboard credential's own provenance is asserted separately below.
//
// `test`, not `all`: `api_keys_mode_kind_ck` (migration 0153) confines the
// mode-crossing `sk_all_` credential to `kind='dashboard'`, and every business this
// suite drives is a test business anyway.
const integration = await createApiKey(orgId, "test");
const tmb = new Tmbilling({ apiKey: integration.secret, baseUrl: `http://127.0.0.1:${port}` });
const authHeaders = { Authorization: `Bearer ${integration.secret}` };

// Drive the lifecycle through the PUBLIC API (source='api', actor=key_…).
const biz = await tmb.businesses.create({
  name: "Events Biz",
  default_currency: "USD",
  livemode: "test",
});
const product = await tmb.products.create(biz.id, { name: "Pro Plan" });
const flat = await tmb.prices.create(biz.id, {
  product: product.id,
  model: "flat",
  currency: "USD",
  amount_minor: 5000,
  interval: "month",
});
const usagePrice = await tmb.prices.create(biz.id, {
  product: product.id,
  model: "usage",
  currency: "USD",
  amount_minor: 10,
  interval: "month",
  usage_aggregation: "sum",
});
await tmb.coupons.create(biz.id, { code: "SAVE10", kind: "percentage", percent_off_bps: 1000 });
const customer = await tmb.customers.create(biz.id, { email: "evt@acme.test", first_name: "Evt" });
await tmb.paymentMethods.create(biz.id, customer.id, { token: "tok_4242" });
const sub = await tmb.subscriptions.create(biz.id, customer.id, {
  items: [{ price: flat.id }, { price: usagePrice.id }],
  trial_days: 14,
});

// Put the trial period into a closed past window, record usage, then renew via
// the clock (source='scheduled_job', actor='billing_clock' — mirrors production).
const subRow = (
  await systemDb.select().from(subscriptions).where(eq(subscriptions.publicId, sub.id)).limit(1)
)[0]!;
const usagePriceRow = (
  await systemDb
    .select()
    .from(prices)
    .where(and(eq(prices.publicId, usagePrice.id), eq(prices.businessId, subRow.businessId)))
    .limit(1)
)[0]!;
const usageItem = (await getSubscriptionItems(orgId, subRow.id)).find(
  (i) => i.priceId === usagePriceRow.id,
)!;
await systemDb
  .update(subscriptions)
  .set({
    currentPeriodStart: new Date(Date.now() - 2 * 3600_000),
    currentPeriodEnd: new Date(Date.now() - 3600_000),
  })
  .where(eq(subscriptions.publicId, sub.id));
await tmb.subscriptions.recordUsage(biz.id, sub.id, {
  item: usageItem.publicId,
  quantity: 100,
  timestamp: new Date(Date.now() - 90 * 60_000).toISOString(),
});
await runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, () =>
  runBillingClockTick(new Date()),
);

// Collect the whole event log for the org (chronological order).
const all = (await listEventsFiltered(orgId, { limit: 100 })).data.slice().reverse();
const seq = all.map((e) => e.type);

// EV-3: every lifecycle event was emitted…
const expected = [
  "product_created",
  "price_created",
  "coupon_created",
  "customer_created",
  "payment_source_added",
  "subscription_created",
  "subscription_started",
  "subscription_activated",
  "subscription_renewed",
  "invoice_generated",
  "usage_recorded",
  "invoice_paid",
];
for (const t of expected) ok(`emitted ${t}`, seq.includes(t));

// …and in the right order. Events in the SAME db transaction share a created_at
// (Postgres transaction timestamp) and would tie-break on random uuid, so we
// assert ordering only across milestones that live in distinct transactions.
function isSubsequence(want: string[], have: string[]): boolean {
  let i = 0;
  for (const h of have) if (h === want[i]) i++;
  return i === want.length;
}
const orderMilestones = [
  "product_created",
  "customer_created",
  "subscription_created",
  "subscription_renewed",
  "invoice_paid",
];
ok("lifecycle milestones emitted in expected order", isSubsequence(orderMilestones, seq));

// EV-2: api-sourced event enrichment (customer.created).
const cusEvt = all.find((e) => e.type === "customer_created")!;
ok("customer.created source=api", cusEvt?.source === "api");
ok("customer.created actor is the api key", (cusEvt?.actor ?? "").startsWith("key_"));
ok(
  "customer.created resource_type/id set",
  cusEvt?.resourceType === "customer" && cusEvt?.resourceId === customer.id,
);
ok(
  "customer.created data carries resource_version",
  typeof (cusEvt?.data as any)?.customer?.resource_version === "number",
);

// EV-2: clock-sourced provenance (subscription.renewed).
const renewedEvt = all.find((e) => e.type === "subscription_renewed")!;
ok("subscription.renewed source=scheduled_job", renewedEvt?.source === "scheduled_job");
ok("subscription.renewed actor=billing_clock", renewedEvt?.actor === "billing_clock");

// EV-2: the org's DASHBOARD credential (what our own UI runs on) is not an integration
// — the same call over the same route records source='dashboard', never a key id. With
// no session forwarded we say `dashboard`, because we know where but not who.
const dashHeaders = { Authorization: `Bearer ${org.secret}` };
const dashCustomer = (await (
  await fetch(`http://127.0.0.1:${port}/v1/businesses/${biz.id}/customers`, {
    method: "POST",
    headers: {
      ...dashHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": "dash-customer-1",
    },
    body: JSON.stringify({ email: "dash@acme.test", first_name: "Dash" }),
  })
).json()) as { id?: string };
const evtFor = async (org: string, id?: string) =>
  (await listEventsFiltered(org, { limit: 100 })).data.find(
    (e) => e.type === "customer_created" && e.resourceId === id,
  );
const dashEvt = await evtFor(orgId, dashCustomer.id);
ok("dashboard-credential request emits source=dashboard", dashEvt?.source === "dashboard");
ok(
  "with no session forwarded the actor is `dashboard`, not a key id",
  dashEvt?.actor === "dashboard",
);
ok("an api-key request is still attributed to its key", cusEvt?.actor?.startsWith("key_") === true);

// …and with the operator's session forwarded (what `dashboard/lib/api.ts` sends on
// every call), the actor is the PERSON. This is the whole point: an audit trail that
// names a credential answers "what called us", not "who did this".
// Unique per run: `signup` rejects a duplicate email, and this suite runs against a DB
// it does not reset — a fixed address passes once and then fails forever.
const operator = `ops+${Date.now().toString(36)}@acme.test`;
const acct = await signup({
  email: operator,
  password: "Sparrow-Lantern-9134",
  name: "Ops",
  organizationName: "Session Co",
});
const sessBiz = await createBusiness({
  organizationId: acct.user.organizationId,
  name: "Session Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const withSession = {
  Authorization: `Bearer ${acct.dashboardKeySecret}`,
  cookie: `tmb_session=${acct.token}`,
  "Content-Type": "application/json",
  "Idempotency-Key": "sess-customer-1",
};
const sessCustomer = (await (
  await fetch(`http://127.0.0.1:${port}/v1/businesses/${sessBiz.publicId}/customers`, {
    method: "POST",
    headers: { ...withSession, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ email: "buyer@acme.test", first_name: "Buyer" }),
  })
).json()) as { id?: string };
const sessEvt = await evtFor(acct.user.organizationId, sessCustomer.id);
ok("a forwarded session names the operator as the actor", sessEvt?.actor === operator);
ok("…still source=dashboard", sessEvt?.source === "dashboard");

// A session from ANOTHER organization is ignored rather than believed — it must never
// be possible to sign an action against org A with a session belonging to org B.
const foreign = (await (
  await fetch(`http://127.0.0.1:${port}/v1/businesses/${biz.id}/customers`, {
    method: "POST",
    headers: {
      ...dashHeaders,
      cookie: `tmb_session=${acct.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "foreign-session-1",
    },
    body: JSON.stringify({ email: "foreign@acme.test", first_name: "Foreign" }),
  })
).json()) as { id?: string };
const foreignEvt = await evtFor(orgId, foreign.id);
ok("a foreign org's session is not trusted as the actor", foreignEvt?.actor === "dashboard");

type KeyList = { data: Array<{ id: string; prefix: string }> };
const keyList = (await (
  await fetch(`http://127.0.0.1:${port}/v1/api_keys`, { headers: dashHeaders })
).json()) as KeyList;
ok(
  "GET /v1/api_keys hides the dashboard credential",
  keyList.data.every((k) => k.id !== org.apiKey.publicId),
);
ok(
  "GET /v1/api_keys lists the integration key",
  keyList.data.some((k) => k.id === integration.apiKey.publicId),
);
const revokeDash = await fetch(
  `http://127.0.0.1:${port}/v1/api_keys/${org.apiKey.publicId}/revoke`,
  {
    method: "POST",
    headers: { ...dashHeaders, "Idempotency-Key": `dashrevoke-${org.apiKey.publicId}` },
  },
);
ok("the dashboard credential cannot be revoked over the API (404)", revokeDash.status === 404);

// EV-4: filter + pagination round-trips via the public API.
type EvList = {
  data: Array<{ id: string; type: string; source: string }>;
  has_more: boolean;
  next_cursor: string | null;
};
const byType = (await (
  await fetch(`http://127.0.0.1:${port}/v1/events?type=customer_created`, { headers: authHeaders })
).json()) as EvList;
ok(
  "GET /v1/events?type= filters",
  byType.data.length >= 1 && byType.data.every((e) => e.type === "customer_created"),
);
const bySource = (await (
  await fetch(`http://127.0.0.1:${port}/v1/events?source=scheduled_job`, { headers: authHeaders })
).json()) as EvList;
ok(
  "GET /v1/events?source= filters",
  bySource.data.length >= 1 && bySource.data.every((e) => e.source === "scheduled_job"),
);
const page1 = (await (
  await fetch(`http://127.0.0.1:${port}/v1/events?limit=1`, { headers: authHeaders })
).json()) as EvList;
ok(
  "GET /v1/events?limit=1 paginates",
  page1.data.length === 1 && page1.has_more === true && !!page1.next_cursor,
);
const page2 = (await (
  await fetch(`http://127.0.0.1:${port}/v1/events?limit=1&starting_after=${page1.next_cursor}`, {
    headers: authHeaders,
  })
).json()) as EvList;
ok(
  "cursor advances to a different event",
  page2.data.length === 1 && page2.data[0]!.id !== page1.data[0]!.id,
);
const bizScoped = (await (
  await fetch(`http://127.0.0.1:${port}/v1/businesses/${biz.id}/events?type=subscription_renewed`, {
    headers: authHeaders,
  })
).json()) as EvList;
ok(
  "business-scoped events endpoint works",
  bizScoped.data.length >= 1 && bizScoped.data.every((e) => e.type === "subscription_renewed"),
);

// ── Review fixes (2026-07-03): contact events + slug 409 + PATCH-id 400 + limit guard ─
const contactRes = await fetch(
  `http://127.0.0.1:${port}/v1/businesses/${biz.id}/customers/${customer.id}/contacts`,
  {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ email: "contact@acme.test", label: "billing" }),
  },
);
const contact = (await contactRes.json()) as { id: string };
await fetch(
  `http://127.0.0.1:${port}/v1/businesses/${biz.id}/customers/${customer.id}/contacts/${contact.id}`,
  {
    method: "PATCH",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ label: "ops" }),
  },
);
await fetch(
  `http://127.0.0.1:${port}/v1/businesses/${biz.id}/customers/${customer.id}/contacts/${contact.id}`,
  {
    method: "DELETE",
    headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
  },
);
const afterContacts = (await listEventsFiltered(orgId, { limit: 100 })).data.map((e) => e.type);
for (const t of [
  "customer_contact_added",
  "customer_contact_updated",
  "customer_contact_removed",
] as const)
  ok(`emitted ${t}`, afterContacts.includes(t));

const dupRes = await fetch(`http://127.0.0.1:${port}/v1/businesses/${biz.id}/products`, {
  method: "POST",
  headers: {
    ...authHeaders,
    "Content-Type": "application/json",
    "Idempotency-Key": `dup-${Date.now()}`,
  },
  body: JSON.stringify({ name: "Pro Plan again", id: product.id }),
});
ok("duplicate explicit product id → 409", dupRes.status === 409);
const patchIdRes = await fetch(
  `http://127.0.0.1:${port}/v1/businesses/${biz.id}/products/${product.id}`,
  {
    method: "PATCH",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ id: "new-slug" }),
  },
);
ok("PATCH id → 400 (immutable)", patchIdRes.status === 400);
const badLimit = await fetch(`http://127.0.0.1:${port}/v1/events?limit=abc`, {
  headers: authHeaders,
});
ok("GET /v1/events?limit=abc → 400", badLimit.status === 400);

// ── Review fix (2026-07-03): fail → dun → recover → cancel event sequence ──────
// A recurring sub billed on a bad card must emit the dunning-open events; swapping
// to a good card and running a dunning pass must emit payment.succeeded+invoice.paid;
// cancelling must emit subscription.canceled. Asserted as an ordered subsequence
// scoped to this subscription's own resource id (isolates it from the lifecycle above).
{
  const dOrg = await createOrganization({ name: "Dunning Events Co" });
  const dOrgId = dOrg.organization.id;
  const dBiz = await createBusiness({
    organizationId: dOrgId,
    name: "Dun Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const dCus = await createCustomer({
    organizationId: dOrgId,
    businessId: dBiz.id,
    email: "dun@evt.test",
  });
  const badPm = await vaultPaymentMethod({
    organizationId: dOrgId,
    businessId: dBiz.id,
    customer: dCus,
    token: "4000000000009995",
  });
  const dProd = await createProduct({
    organizationId: dOrgId,
    businessId: dBiz.id,
    name: "Dun Plan",
  });
  const dPrice = await createPrice({
    organizationId: dOrgId,
    businessId: dBiz.id,
    productId: dProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const dSub = await createSubscription({
    organizationId: dOrgId,
    businessId: dBiz.id,
    customerId: dCus.id,
    now: new Date(),
    items: [{ price: dPrice, quantity: 1 }],
    defaultPaymentMethodId: badPm.id,
  });
  // First bill: bad card → payment.failed + dunning opens.
  const { invoice: dInv } = await billSubscriptionPeriod({
    organizationId: dOrgId,
    businessId: dBiz.id,
    subscription: dSub.subscription,
    periodStart: dSub.subscription.currentPeriodStart!,
    periodEnd: dSub.subscription.currentPeriodEnd!,
  });
  // Swap to a good card, point the sub at it, backdate the retry, run a dunning pass → recover.
  const goodPm = await vaultPaymentMethod({
    organizationId: dOrgId,
    businessId: dBiz.id,
    customer: dCus,
    token: "tok_4242",
  });
  await withTenant(dOrgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ defaultPaymentMethodId: goodPm.id })
      .where(eq(subscriptions.id, dSub.subscription.id)),
  );
  await systemDb
    .update(invoices)
    .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
    .where(eq(invoices.id, dInv.id));
  await runWithEventContext({ source: "scheduled_job", actor: "billing_clock" }, () =>
    runDunningPass(new Date()),
  );
  // Cancel immediately.
  await cancelSubscription({
    organizationId: dOrgId,
    businessId: dBiz.id,
    subscriptionId: dSub.subscription.id,
    atPeriodEnd: false,
    now: new Date(),
  });

  const dEvents = (await listEventsFiltered(dOrgId, { limit: 100 })).data
    .slice()
    .reverse()
    .map((e) => e.type);
  ok("dunning: payment.failed emitted", dEvents.includes("payment_failed"));
  ok("dunning: invoice.dunning_started emitted", dEvents.includes("invoice_dunning_started"));
  ok("dunning: invoice.payment_due emitted", dEvents.includes("invoice_payment_due"));
  ok("dunning: payment.succeeded emitted on recovery", dEvents.includes("payment_succeeded"));
  ok("dunning: invoice.paid emitted on recovery", dEvents.includes("invoice_paid"));
  ok("dunning: subscription.canceled emitted", dEvents.includes("subscription_canceled"));

  // ── an invoice zeroed by an ADJUSTMENT credit note is paid, and says so ─────
  /**
   * `invoice_paid` is deliberately ours: it also fires for credit-covered (amount-due-0)
   * invoices, which a `payment_succeeded` event cannot signal.
   *
   * `invoicing/ops.ts::applyCreditsToInvoice` honours that. `issueAdjustmentCreditNote` did
   * not, so an invoice a credit note drove to zero went `payment_due → paid` emitting only
   * `invoice_updated` — measured on INV-6287, 2026-09-03, in an organization where 37,024
   * cash settlements had fired correctly. A subscriber tracking settlement missed it.
   *
   * Its own organization, so `listEventsFiltered` cannot be satisfied by some other
   * fixture's `invoice_paid` — the bug is the ABSENCE of one, and a shared org would hide
   * it behind an unrelated pass.
   */
  const cOrg = await createOrganization({ name: "Events CreditPaid" });
  const cOrgId = cOrg.organization.id;
  const cBiz = await createBusiness({
    organizationId: cOrgId,
    name: "CP",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const cCus = await createCustomer({
    organizationId: cOrgId,
    businessId: cBiz.id,
    email: "creditpaid@ev.test",
  });
  const cProduct = await createProduct({
    organizationId: cOrgId,
    businessId: cBiz.id,
    name: "CP plan",
    kind: "plan",
  });
  const cPrice = await createPrice({
    organizationId: cOrgId,
    businessId: cBiz.id,
    productId: cProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5_000,
    interval: "month",
  });
  // No payment method at all: the invoice is raised and stays unpaid, which is the state a
  // credit note then has to settle.
  const cSub = await createSubscription({
    organizationId: cOrgId,
    businessId: cBiz.id,
    customerId: cCus.id,
    now: new Date(),
    items: [{ price: cPrice, quantity: 1 }],
  });
  const { invoice: cInv } = await billSubscriptionPeriod({
    organizationId: cOrgId,
    businessId: cBiz.id,
    subscription: cSub.subscription,
    periodStart: cSub.subscription.currentPeriodStart!,
    periodEnd: cSub.subscription.currentPeriodEnd!,
  });
  // Credit the whole invoice, so `zeroed` is true and the paid transition fires.
  await issueAdjustmentCreditNote({
    organizationId: cOrgId,
    businessId: cBiz.id,
    invoicePublicId: cInv.publicId,
    items: [{ description: "zeroing it", amountMinor: Number(cInv.totalMinor) }],
  });
  const cInvAfter = (
    await withTenant(cOrgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, cInv.id)).limit(1),
    )
  )[0]!;
  const cEvents = (await listEventsFiltered(cOrgId, { limit: 100 })).data.map((e) => e.type);
  ok(
    `credit-paid: precondition — the credit note drove the invoice to paid (${cInvAfter.status})`,
    cInvAfter.status === "paid",
  );
  ok(
    "credit-paid: invoice.paid emitted for a credit-covered invoice",
    cEvents.includes("invoice_paid"),
  );
  ok(
    "credit-paid: …and the credit note events fired alongside it",
    cEvents.includes("credit_note_created") && cEvents.includes("invoice_updated"),
  );
  // Order asserted only across distinct transactions (first-bill fail → recovery
  // pass → cancel); same-tx events tie-break on random uuid so aren't ordered.
  ok(
    "dunning: fail → recover → cancel in order",
    isSubsequence(["payment_failed", "payment_succeeded", "subscription_canceled"], dEvents),
  );
}

// ── a real plan change MUST emit subscription_changed ────────────────────────
//
// Added 2026-08-25 because nothing else asserted it: the event is emitted from
// coupons/service, proration and two places in subscriptions/service, and no suite
// checked any of them. Silently ceasing to emit it on a real change would go unnoticed.
// This does check.
{
  // Its own tenant, like the dunning block above — the SDK-created `biz` in this script
  // carries a PUBLIC id, and these service calls take internal ones.
  const cOrg = await createOrganization({ name: "Change Events Org" });
  const cOrgId = cOrg.organization.id;
  const cBiz = await createBusiness({
    organizationId: cOrgId,
    name: "Change Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ctx = { organizationId: cOrgId, businessId: cBiz.id };
  const customer = await createCustomer({ ...ctx, email: "evt-change@example.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const product = await createProduct({ ...ctx, name: "Change Plan" });
  const mk = (amt: number) =>
    createPrice({
      ...ctx,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: amt,
      interval: "month",
    });
  const from = await mk(10000);
  const to = await mk(30000);
  const termStart = new Date("2026-08-01T00:00:00.000Z");
  const sub = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: termStart,
    items: [{ price: from, quantity: 1 }],
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  await changeSubscription({
    ...ctx,
    subscriptionId: sub.subscription.id,
    changes: [{ itemId: sub.items[0]!.publicId, newPriceId: to.publicId }],
    prorate: true,
    invoiceImmediately: true,
    now: new Date("2026-08-16T00:00:00.000Z"),
  });
  const evs = await listEventsFiltered(cOrgId, { businessId: cBiz.id, limit: 200 });
  const rows = (evs as { data?: Array<{ type: string }> }).data ?? [];
  const saw = rows.some((e) => e.type === "subscription_changed");
  ok("a mid-term plan change emits subscription_changed", saw);
}

// ── webhook_status filter: the same rollup the list prints ──────────────────────
{
  type WsList = { data: Array<{ id: string; webhook_status: string }> };
  const get = async (qs: string) =>
    fetch(`http://127.0.0.1:${port}/v1/businesses/${biz.id}/events?${qs}`, {
      headers: authHeaders,
    });
  const plain = (await (await get("limit=5")).json()) as WsList;
  ok(
    "events list without webhook_status still prints webhook_status",
    plain.data.length > 0 && plain.data.every((e) => typeof e.webhook_status === "string"),
  );
  const target = plain.data[0]!;
  const [evRow] = await systemDb
    .select({ id: events.id, organizationId: events.organizationId })
    .from(events)
    .where(eq(events.publicId, target.id))
    .limit(1);
  await systemDb.insert(webhookDeliveries).values({
    organizationId: evRow!.organizationId,
    eventId: evRow!.id,
    endpointId: crypto.randomUUID(),
    status: "failed",
  });
  const failed = (await (await get("webhook_status[is]=failed")).json()) as WsList;
  ok(
    "webhook_status[is]=failed returns exactly the event with a failed delivery",
    failed.data.length === 1 &&
      failed.data[0]!.id === target.id &&
      failed.data[0]!.webhook_status === "failed",
  );
  const notCfg = (await (await get("webhook_status[in]=not_configured,pending")).json()) as WsList;
  ok(
    "webhook_status[in]=… returns only matching rollups and leaves the failed one out",
    notCfg.data.length > 0 &&
      notCfg.data.every((e) => ["not_configured", "pending"].includes(e.webhook_status)) &&
      !notCfg.data.some((e) => e.id === target.id),
  );
  const notFailed = (await (await get("webhook_status[is_not]=failed")).json()) as WsList;
  ok("webhook_status[is_not]=failed excludes it", !notFailed.data.some((e) => e.id === target.id));
  ok(
    "webhook_status[is]=succeeded → 400",
    (await get("webhook_status[is]=succeeded")).status === 400,
  );
  ok("webhook_status[gt]=failed → 400", (await get("webhook_status[gt]=failed")).status === 400);
}

// ── comments: retrieve, business-wide + paged list ──────────────────────────────
{
  const base = `http://127.0.0.1:${port}/v1/businesses/${biz.id}/comments`;
  const post = async (body: string) =>
    (await (
      await fetch(base, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ resource_type: "customer", resource_id: customer.id, body }),
      })
    ).json()) as { id: string; body: string; author: string };
  const c1 = await post("first note");
  const c2 = await post("second note");
  const one = await fetch(`${base}/${c1.id}`, { headers: authHeaders });
  const oneBody = (await one.json()) as { id: string; body: string };
  ok(
    "GET /comments/:id → 200",
    one.status === 200 && oneBody.id === c1.id && oneBody.body === "first note",
  );
  ok(
    "GET /comments/:id unknown → 404",
    (await fetch(`${base}/cmt_nope`, { headers: authHeaders })).status === 404,
  );
  type CList = {
    data: Array<{ id: string }>;
    has_more: boolean;
    next_cursor: string | null;
    total: number | null;
  };
  const perRecord = (await (
    await fetch(`${base}?resource_type=customer&resource_id=${customer.id}`, {
      headers: authHeaders,
    })
  ).json()) as CList;
  ok(
    "per-record list unchanged: oldest first, unpaged",
    perRecord.data.map((c) => c.id).join() === [c1.id, c2.id].join() &&
      perRecord.has_more === false &&
      perRecord.total === 2,
  );
  ok(
    "resource_type without resource_id is still a 400",
    (await fetch(`${base}?resource_type=customer`, { headers: authHeaders })).status === 400,
  );
  const wide = (await (await fetch(base, { headers: authHeaders })).json()) as CList;
  ok(
    "business-wide list (no resource) → both comments",
    wide.data.some((c) => c.id === c1.id) && wide.data.some((c) => c.id === c2.id),
  );
  const p1 = (await (await fetch(`${base}?limit=1`, { headers: authHeaders })).json()) as CList;
  const p2 = (await (
    await fetch(`${base}?limit=1&starting_after=${p1.next_cursor}`, { headers: authHeaders })
  ).json()) as CList;
  ok(
    "comments ?limit=1 pages with a cursor",
    p1.data.length === 1 &&
      p1.has_more &&
      p2.data.length === 1 &&
      p2.data[0]!.id !== p1.data[0]!.id,
  );
  const desc = (await (
    await fetch(`${base}?sort_by[desc]=created_at&resource_id=${customer.id}`, {
      headers: authHeaders,
    })
  ).json()) as CList;
  ok("comments sort_by[desc]=created_at → newest first", desc.data[0]?.id === c2.id);
  const future = (await (
    await fetch(`${base}?created_at[after]=2999-01-01`, { headers: authHeaders })
  ).json()) as CList;
  ok("comments created_at[after] filters", future.data.length === 0);
  ok(
    "comments unknown list param on the paged path → 400",
    (await fetch(`${base}?limit=1&bogus=1`, { headers: authHeaders })).status === 400,
  );
}

await app.close();

// ── report ───────────────────────────────────────────────────────────────────
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ EVENTS: PASS" : "❌ EVENTS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
